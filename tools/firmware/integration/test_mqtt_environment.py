"""Check the FCPLCn local MQTT test environment, not the ESP32 application."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import time
from uuid import uuid4

import paho.mqtt.client as mqtt
import pytest


TIMEOUT_SECONDS = 5.0


def _mosquitto_binary() -> str:
    candidates = (
        os.environ.get("MOSQUITTO_BIN"),
        "/opt/homebrew/sbin/mosquitto",
        "/opt/homebrew/bin/mosquitto",
        shutil.which("mosquitto"),
    )
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    pytest.fail("Mosquitto not found. Install it with brew install mosquitto.")


@pytest.fixture
def local_broker(tmp_path: Path):
    """Run an isolated loopback-only broker and always reap its process."""
    executable = _mosquitto_binary()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]

    config = tmp_path / "mosquitto.conf"
    config.write_text(
        f"listener {port} 127.0.0.1\n"
        "allow_anonymous true\n"
        "persistence false\n",
        encoding="utf-8",
    )
    log_path = tmp_path / "mosquitto.log"
    with log_path.open("wb") as log:
        broker = subprocess.Popen(
            [executable, "-c", str(config), "-v"],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + TIMEOUT_SECONDS
            while True:
                if broker.poll() is not None:
                    pytest.fail(
                        "Temporary Mosquitto exited before startup:\n"
                        + log_path.read_text(encoding="utf-8", errors="replace")
                    )
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        pytest.fail("Temporary Mosquitto did not start within 5 seconds.")
                    time.sleep(0.05)
            yield "127.0.0.1", port
        finally:
            if broker.poll() is None:
                broker.terminate()
                try:
                    broker.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    broker.kill()
                    broker.wait(timeout=3)


def _receive(events: queue.Queue, description: str):
    try:
        return events.get(timeout=TIMEOUT_SECONDS)
    except queue.Empty:
        pytest.fail(f"Timed out after 5 seconds waiting for {description}.")


@contextmanager
def _connected_client(host: str, port: int, role: str):
    connected = queue.Queue()
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"fcplcn-host-smoke-{role}-{uuid4().hex}",
        protocol=mqtt.MQTTv311,
        reconnect_on_failure=False,
    )
    client.connect_timeout = TIMEOUT_SECONDS

    def on_connect(_client, _userdata, _flags, reason_code, _properties):
        connected.put(reason_code)

    client.on_connect = on_connect
    try:
        assert client.connect(host, port, keepalive=10) == mqtt.MQTT_ERR_SUCCESS
        assert client.loop_start() == mqtt.MQTT_ERR_SUCCESS
        reason_code = _receive(connected, f"{role} CONNACK")
        assert not reason_code.is_failure, f"{role} connection refused: {reason_code}"
        yield client
    finally:
        try:
            client.disconnect()
        finally:
            client.loop_stop()


def test_mqtt_qos1_publish_subscribe(local_broker):
    """Two clients exchange an exact UTF-8 payload after the broker's SUBACK."""
    host, port = local_broker
    subscribed = queue.Queue()
    received = queue.Queue()
    topic = f"fcplcn-environment-smoke/{uuid4().hex}/telemetry"
    payload = json.dumps(
        {"device": "fcplcn-host-test", "status": "проверка связи", "sequence": 1},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    with (
        _connected_client(host, port, "subscriber") as subscriber,
        _connected_client(host, port, "publisher") as publisher,
    ):
        def on_subscribe(_client, _userdata, _mid, reason_codes, _properties):
            subscribed.put(reason_codes)

        def on_message(_client, _userdata, message):
            received.put((message.topic, message.payload, message.qos, message.retain))

        subscriber.on_subscribe = on_subscribe
        subscriber.on_message = on_message
        result, _mid = subscriber.subscribe(topic, qos=1)
        assert result == mqtt.MQTT_ERR_SUCCESS
        reason_codes = _receive(subscribed, "SUBACK")
        assert len(reason_codes) == 1 and reason_codes[0] == 1, reason_codes

        publication = publisher.publish(topic, payload=payload, qos=1, retain=False)
        assert publication.rc == mqtt.MQTT_ERR_SUCCESS
        publication.wait_for_publish(timeout=TIMEOUT_SECONDS)
        assert publication.is_published(), "PUBACK not received within 5 seconds."
        assert _receive(received, "published message") == (topic, payload, 1, False)
