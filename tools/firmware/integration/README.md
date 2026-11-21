# FCPLCn MQTT test environment

Run from the project root:

```sh
tools/firmware/test-mqtt
```

This checks the Python/MQTT integration environment; it does not test the ESP32
application. The test starts a temporary Mosquitto process on an available
`127.0.0.1` port, waits for MQTT connection/subscription acknowledgements, then
checks a QoS 1 publication between two separate clients. The broker and clients
are stopped after the test, including on failure. It does not use or start a
system broker service. Persistence is disabled and authentication is anonymous
only for this temporary loopback listener.

The environment uses Python 3.12 and requires Mosquitto (`brew install mosquitto`).
The test checks `/opt/homebrew/sbin/mosquitto`, `/opt/homebrew/bin/mosquitto`, and
`PATH`; set `MOSQUITTO_BIN` to use a different executable.

Recreate only the project's virtual environment:

```sh
/opt/homebrew/bin/python3.12 -m venv tools/firmware/integration/.venv
tools/firmware/integration/.venv/bin/python -m pip install -r tools/firmware/integration/requirements.lock.txt
```

Broker startup, socket connection, MQTT acknowledgements, and message receipt
have finite timeouts. Broker shutdown escalates from terminate to kill if needed.
