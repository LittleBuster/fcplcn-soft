"""Routing, credential parsing, and durable deployment rollback regression tests.

All Docker/package/network operations are mocked. These tests may run as an
ordinary user and never invoke the privileged installers.
"""

import base64
import copy
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("vpn_cascade", ROOT / "src" / "cascade.py")
cascade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cascade)

PUBLIC_KEY = base64.urlsafe_b64encode(bytes(range(1, 33))).decode("ascii").rstrip("=")
PRIVATE_KEY = base64.urlsafe_b64encode(bytes(range(32, 64))).decode("ascii").rstrip("=")
UPLINK_UUID = "508f9691-7fc9-4bdb-8ede-245a358d4d17"
USER_UUID = "358d0275-b678-4d35-b633-b2714360a914"


def remote():
    return {
        "host": "9.9.9.9", "port": 443, "uuid": UPLINK_UUID,
        "sni": "www.microsoft.com", "public_key": PUBLIC_KEY,
        "short_id": "0123456789abcdef", "fingerprint": "chrome",
    }


def fixture(role="ru"):
    state = {
        "version": cascade.VERSION, "role": role,
        "host": "8.8.8.8" if role == "ru" else "9.9.9.9", "port": 443,
        "sni": "www.microsoft.com", "private_key": PRIVATE_KEY,
        "public_key": PUBLIC_KEY, "short_id": "0123456789abcdef",
        "image": "ghcr.io/xtls/xray-core@sha256:" + "a" * 64,
        "created_at": "2026-11-19T00:00:00+00:00",
    }
    if role == "ru":
        state["users"] = [{"name": "phone", "uuid": USER_UUID, "created_at": state["created_at"]}]
        state["armenia"] = remote()
    else:
        state["service_uuid"] = UPLINK_UUID
        state["ru_ip"] = "8.8.8.8"
    return state


class LinkAndUserTests(unittest.TestCase):
    def link(self, **changes):
        fields = {
            "encryption": "none", "security": "reality", "type": "tcp",
            "flow": cascade.FLOW, "sni": "www.microsoft.com", "fp": "chrome",
            "pbk": PUBLIC_KEY, "sid": "0123456789abcdef",
        }
        fields.update(changes)
        return "vless://" + UPLINK_UUID + "@9.9.9.9:443?" + urlencode(fields) + "#ru-uplink"

    def test_arm_link_roundtrips_without_private_key(self):
        state = fixture("arm")
        link = cascade.make_vless_link(cascade.endpoint(state), state["service_uuid"], "ru-uplink")
        self.assertEqual(cascade.parse_vless_link(link), remote())
        self.assertNotIn(PRIVATE_KEY, link)
        self.assertNotIn("Hash32", link)

    def test_names_are_encoded_as_fragment_not_injected_query(self):
        link = cascade.make_vless_link(remote(), UPLINK_UUID, "test #&security=none")
        self.assertEqual(parse_qs(urlsplit(link).query)["security"], ["reality"])
        self.assertIn("%23", link)
        self.assertIn("%26", link)

    def test_rejects_unexpected_protocol_or_transport_options(self):
        for change in (
            {"security": "none"}, {"security": "tls"}, {"type": "ws"},
            {"flow": ""}, {"encryption": "arbitrary"}, {"fp": "random"},
            {"headerType": "http"}, {"spx": "/unexpected"}, {"allowInsecure": "1"},
        ):
            with self.subTest(change=change), self.assertRaises(cascade.SetupError):
                cascade.parse_vless_link(self.link(**change))
        with self.assertRaises(cascade.SetupError):
            cascade.parse_vless_link(self.link().replace("vless://", "https://", 1))

    def test_rejects_duplicate_and_control_parameters(self):
        for link in (
            self.link().replace("#ru-uplink", "&security=none#ru-uplink"),
            self.link().replace("#ru-uplink", "&sid=aa#ru-uplink"),
            self.link().replace("9.9.9.9", "9.9.9.9\n"),
            self.link().replace("9.9.9.9", "9.9.9.9\x00"),
            self.link().replace(UPLINK_UUID + "@", UPLINK_UUID + ":password@"),
        ):
            with self.subTest(link=repr(link)), self.assertRaises(cascade.SetupError):
                cascade.parse_vless_link(link)

    def test_rejects_private_or_missing_service_endpoint(self):
        for host in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2",
                     "224.0.0.1", "255.255.255.255", "example.com"):
            with self.subTest(host=host), self.assertRaises(cascade.SetupError):
                cascade.parse_vless_link(self.link().replace("9.9.9.9", host))
        with self.assertRaises(cascade.SetupError):
            cascade.parse_vless_link(self.link().replace(":443?", "?"))

    def test_rejects_invalid_uuid_key_sni_and_short_id(self):
        for link in (
            self.link().replace(UPLINK_UUID, "not-a-uuid"),
            self.link(pbk="A" * 43),
            self.link(pbk=PUBLIC_KEY + "="),
            self.link(sni="https://example.com/path"),
            self.link(sni="1.1.1.1"),
            self.link(sid="abc"),
            self.link(sid="gg"),
            self.link(sid="aa" * 9),
        ):
            with self.subTest(link=link), self.assertRaises(cascade.SetupError):
                cascade.parse_vless_link(link)

    def test_accepts_compatible_raw_short_id_and_udp_flow(self):
        parsed = cascade.parse_vless_link(self.link(type="raw", sid="AABB", flow=cascade.FLOW_UDP))
        self.assertEqual(parsed["short_id"], "aabb")
        self.assertEqual(parsed["uuid"], UPLINK_UUID)

    def test_add_user_returns_copy_preserving_keys_upstream_and_old_users(self):
        old = fixture()
        before = copy.deepcopy(old)
        updated = cascade.add_user(old, "laptop")
        self.assertEqual(old, before)
        self.assertEqual(updated["users"][:-1], before["users"])
        self.assertEqual(updated["armenia"], before["armenia"])
        for key in ("private_key", "public_key", "short_id", "image", "created_at"):
            self.assertEqual(updated[key], before[key])
        self.assertNotEqual(updated["users"][-1]["uuid"], USER_UUID)
        self.assertEqual(updated["users"][-1]["name"], "laptop")

    def test_duplicate_or_unsafe_user_names_are_rejected(self):
        for name in ("phone", "PHONE", "../escape", "name/child", "with space", "$(id)", "", "x" * 65):
            with self.subTest(name=name), self.assertRaises(cascade.SetupError):
                cascade.add_user(fixture(), name)
        with self.assertRaises(cascade.SetupError):
            cascade.add_user(fixture("arm"), "user2")


class ConfigurationTests(unittest.TestCase):
    def test_ru_routing_preserves_private_block_geoip_and_armenia_default(self):
        config = cascade.make_config(fixture())
        rules = config["routing"]["rules"]
        self.assertEqual(config["routing"]["domainStrategy"], "IPOnDemand")
        private = next(i for i, rule in enumerate(rules) if rule.get("ip") == ["geoip:private"])
        country = next(i for i, rule in enumerate(rules) if rule.get("ip") == ["geoip:ru"])
        self.assertLess(private, country)
        self.assertEqual(rules[private]["outboundTag"], "block")
        self.assertEqual(rules[country]["outboundTag"], "direct")
        self.assertEqual(rules[country]["inboundTag"], ["clients-in"])
        self.assertEqual(rules[-1]["outboundTag"], "armenia")
        self.assertEqual(rules[-1]["network"], "tcp,udp")
        self.assertEqual(config["outbounds"][0]["tag"], "armenia")
        self.assertNotIn("balancers", config["routing"])
        self.assertFalse(config["inbounds"][0]["sniffing"]["enabled"])

    def test_ru_dns_russian_answers_filtered_and_foreign_queries_cascaded(self):
        config = cascade.make_config(fixture())
        dns = config["dns"]
        self.assertEqual(dns["queryStrategy"], "UseIPv4")
        self.assertFalse(dns["enableParallelQuery"])
        self.assertFalse(dns["disableCache"])
        self.assertEqual(dns["servers"][0]["expectedIPs"], ["geoip:ru"])
        self.assertEqual(dns["hosts"][cascade.RU_DNS_HOST], cascade.RU_DNS_IP)
        rules = config["routing"]["rules"]
        dns_rules = [rule for rule in rules if rule.get("inboundTag") == [dns["tag"]]]
        self.assertEqual(dns_rules[0]["outboundTag"], "direct")
        self.assertEqual(dns_rules[-1]["outboundTag"], "armenia")
        self.assertNotIn("domain", dns_rules[-1])
        self.assertLess(rules.index(dns_rules[-1]), next(
            i for i, rule in enumerate(rules) if rule.get("ip") == ["geoip:ru"]))

    def test_direct_exit_enforces_country_and_blocks_private_addresses(self):
        config = cascade.make_config(fixture())
        direct = next(outbound for outbound in config["outbounds"] if outbound["tag"] == "direct")
        final_rules = direct["settings"]["finalRules"]
        self.assertEqual(final_rules[0], {"action": "block", "ip": ["geoip:private"]})
        self.assertIn({"action": "allow", "ip": ["geoip:ru"]}, final_rules)
        self.assertEqual(final_rules[-1], {"action": "block", "network": "tcp,udp"})
        self.assertEqual(direct["streamSettings"]["sockopt"]["domainStrategy"], "ForceIPv4")

    def test_armenia_hop_uses_service_credential_not_end_user(self):
        state = cascade.add_user(fixture(), "laptop")
        config = cascade.make_config(state)
        arm = next(outbound for outbound in config["outbounds"] if outbound["tag"] == "armenia")
        self.assertEqual(arm["settings"]["id"], UPLINK_UUID)
        self.assertNotIn(arm["settings"]["id"], [user["uuid"] for user in state["users"]])
        self.assertEqual(arm["targetStrategy"], "ForceIPv4")
        self.assertEqual(arm["settings"]["flow"], cascade.FLOW_UDP)
        self.assertNotIn("proxySettings", arm)

    def test_arm_only_accepts_one_authenticated_service_user_from_ru(self):
        state = fixture("arm")
        config = cascade.make_config(state)
        users = config["inbounds"][0]["settings"]["users"]
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0]["id"], UPLINK_UUID)
        self.assertEqual(users[0]["flow"], cascade.FLOW)
        allowed = [rule for rule in config["routing"]["rules"] if rule["outboundTag"] == "direct"]
        self.assertEqual(len(allowed), 1)
        self.assertEqual(allowed[0]["sourceIP"], [state["ru_ip"] + "/32"])
        self.assertEqual(allowed[0]["inboundTag"], ["from-ru"])
        self.assertEqual(config["routing"]["rules"][-1]["outboundTag"], "block")
        self.assertEqual(config["outbounds"][0]["tag"], "block")

    def test_client_profile_only_knows_ru_and_keeps_destination_dns_remote(self):
        state = fixture()
        config = cascade.make_client_config(cascade.endpoint(state), USER_UUID)
        self.assertEqual(config["inbounds"][0]["listen"], "127.0.0.1")
        self.assertEqual(len(config["outbounds"]), 1)
        outbound = config["outbounds"][0]
        self.assertEqual(outbound["settings"]["address"], state["host"])
        self.assertEqual(outbound["settings"]["id"], USER_UUID)
        self.assertEqual(outbound["targetStrategy"], "AsIs")
        self.assertNotIn(UPLINK_UUID, json.dumps(config))
        self.assertNotIn(PRIVATE_KEY, json.dumps(config))

    def test_compose_mounts_config_directory_for_atomic_replacement(self):
        text = cascade.compose_text(fixture())
        self.assertIn("./runtime:/usr/local/etc/xray:ro", text)
        self.assertNotIn("./runtime/config.json:", text)
        self.assertIn("read_only: true", text)
        self.assertIn("cap_drop: [ALL]", text)
        self.assertIn("cap_add: [NET_BIND_SERVICE]", text)
        self.assertNotIn("privileged:", text)
        self.assertIn("@sha256:" + "a" * 64, text)
        self.assertIn("pull_policy: never", text)


class DeploymentTests(unittest.TestCase):
    paths = ("state.json", "compose.yaml", "runtime/config.json")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vpn-cascade-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "deployment"
        self.deployment = cascade.Deployment(self.root, "ru")
        self.validator = mock.patch.object(self.deployment, "validate").start()
        self.activator = mock.patch.object(self.deployment, "activate").start()
        self.compose = mock.patch.object(self.deployment, "compose").start()
        self.addCleanup(mock.patch.stopall)

    def snapshot(self):
        return {name: (self.root / name).read_bytes() for name in self.paths}

    def install(self):
        state = fixture()
        self.deployment.apply_state(state)
        return state

    def test_successful_add_preserves_existing_uuid_and_exports_new_profile(self):
        initial = self.install()
        old_profile = (self.root / "clients/phone.txt").read_bytes()
        updated = cascade.add_user(initial, "laptop")
        self.deployment.apply_state(updated)
        loaded = self.deployment.load_state()
        self.assertEqual(loaded, updated)
        self.assertEqual(loaded["users"][0]["uuid"], USER_UUID)
        self.assertEqual((self.root / "clients/phone.txt").read_bytes(), old_profile)
        new_link = (self.root / "clients/laptop.txt").read_text().strip()
        self.assertEqual(cascade.parse_vless_link(new_link)["uuid"], updated["users"][-1]["uuid"])
        runtime = json.loads((self.root / "runtime/config.json").read_text())
        self.assertEqual(len(runtime["inbounds"][0]["settings"]["users"]), 2)
        self.assertFalse((self.root / "pending").exists())
        for name in self.paths + ("clients/phone.txt", "clients/laptop.json"):
            self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o600)

    def test_validation_failure_does_not_touch_running_files_or_restart(self):
        initial = self.install()
        before = self.snapshot()
        self.activator.reset_mock()
        self.validator.side_effect = cascade.SetupError("invalid candidate")
        with self.assertRaisesRegex(cascade.SetupError, "invalid candidate"):
            self.deployment.apply_state(cascade.add_user(initial, "laptop"))
        self.assertEqual(self.snapshot(), before)
        self.activator.assert_not_called()
        self.assertFalse((self.root / "pending").exists())

    def test_restart_failure_restores_state_config_and_reactivates_previous_service(self):
        initial = self.install()
        before = self.snapshot()
        self.activator.reset_mock()
        self.activator.side_effect = [cascade.SetupError("startup failed"), None]
        with self.assertRaisesRegex(cascade.SetupError, "Изменение отменено"):
            self.deployment.apply_state(cascade.add_user(initial, "laptop"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.deployment.load_state(), initial)
        self.assertEqual(self.activator.call_count, 2)
        self.compose.assert_not_called()
        self.assertFalse((self.root / "pending").exists())
        self.assertFalse((self.root / "clients/laptop.txt").exists())

    def test_first_install_failure_stops_partial_container_and_removes_live_files(self):
        self.activator.side_effect = cascade.SetupError("startup failed")
        with self.assertRaisesRegex(cascade.SetupError, "Изменение отменено"):
            self.deployment.apply_state(fixture())
        self.compose.assert_called_once_with("down")
        self.assertIsNone(self.deployment.load_state())
        for name in self.paths:
            self.assertFalse((self.root / name).exists(), name)
        self.assertFalse((self.root / "pending").exists())

    def test_recovery_of_interrupted_update_restores_authoritative_files(self):
        initial = self.install()
        before = self.snapshot()
        pending = self.root / "pending"
        pending.mkdir()
        for name, content in before.items():
            (pending / name.replace("/", "__")).write_bytes(content)
            (self.root / name).write_bytes(b"partial unfinished replacement")
        (pending / "manifest.json").write_text(json.dumps(list(self.paths)))
        self.activator.reset_mock()
        self.deployment.recover()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.deployment.load_state(), initial)
        self.activator.assert_called_once_with()
        self.assertFalse(pending.exists())

    def test_failed_recovery_keeps_journal_available_for_next_attempt(self):
        initial = self.install()
        self.activator.side_effect = cascade.SetupError("persistent daemon error")
        with self.assertRaisesRegex(cascade.SetupError, "Журнал сохранён"):
            self.deployment.apply_state(cascade.add_user(initial, "laptop"))
        self.assertTrue((self.root / "pending/manifest.json").exists())
        self.activator.side_effect = None
        self.deployment.recover()
        self.assertEqual(self.deployment.load_state(), initial)
        self.assertFalse((self.root / "pending").exists())

    def test_refuses_overwriting_existing_config_without_managed_state(self):
        self.root.mkdir()
        (self.root / "runtime").mkdir()
        existing = self.root / "runtime/config.json"
        existing.write_bytes(b"existing unowned config")
        with self.assertRaisesRegex(cascade.SetupError, "без state.json"):
            self.deployment.apply_state(fixture())
        self.assertEqual(existing.read_bytes(), b"existing unowned config")
        self.activator.assert_not_called()

    def test_rejects_invalid_recovery_manifest_without_deleting_journal(self):
        self.root.mkdir()
        pending = self.root / "pending"
        pending.mkdir()
        (pending / "manifest.json").write_text(json.dumps(["../../outside"]))
        with self.assertRaisesRegex(cascade.SetupError, "Повреждён журнал"):
            self.deployment.recover()
        self.assertTrue(pending.exists())
        self.activator.assert_not_called()

    def test_atomic_write_refuses_symlink_and_does_not_touch_target(self):
        target = Path(self.temp.name) / "outside.txt"
        target.write_bytes(b"preserve me")
        self.root.mkdir()
        link = self.root / "link"
        link.symlink_to(target)
        with self.assertRaisesRegex(cascade.SetupError, "символическую ссылку"):
            cascade.atomic_write(link, b"new data")
        self.assertEqual(target.read_bytes(), b"preserve me")

    def test_x25519_parser_uses_password_public_key_not_hash32(self):
        output = "PrivateKey: {}\nPassword (PublicKey): {}\nHash32: {}\n".format(
            PRIVATE_KEY, PUBLIC_KEY, "not-a-reality-password")
        with mock.patch.object(cascade, "run_command", return_value=output):
            self.assertEqual(self.deployment.keypair(cascade.DEFAULT_IMAGE), (PRIVATE_KEY, PUBLIC_KEY))

    def test_concurrent_installer_is_rejected_until_first_releases_lock(self):
        second = cascade.Deployment(self.root, "ru")
        with self.deployment.locked():
            with self.assertRaisesRegex(cascade.SetupError, "Другой экземпляр"):
                with second.locked():
                    self.fail("second installer unexpectedly acquired the lock")
        with second.locked():
            self.assertIsNone(second.load_state())

    def test_lock_boundary_rejects_managed_directory_symlinks(self):
        self.root.mkdir()
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.root / "runtime").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(cascade.SetupError, "символическая ссылка"):
            with self.deployment.locked():
                self.fail("managed path symlink unexpectedly accepted")
        self.assertEqual(list(outside.iterdir()), [])

    def test_activation_accepts_historical_restart_count_without_new_restarts(self):
        self.compose.side_effect = lambda *args: "fake-container" if args[0] == "ps" else ""
        with mock.patch.object(cascade, "run_command", return_value="running 4") as command, \
                mock.patch.object(cascade.time, "sleep"):
            cascade.Deployment.activate(self.deployment)
        self.assertEqual(command.call_count, 3)

    def test_activation_detects_new_container_crash_loop(self):
        self.compose.side_effect = lambda *args: "fake-container" if args[0] == "ps" else ""
        with mock.patch.object(cascade, "run_command", side_effect=["running 4", "running 5"]), \
                mock.patch.object(cascade.time, "sleep"), \
                self.assertRaisesRegex(cascade.SetupError, "перезапускается"):
            cascade.Deployment.activate(self.deployment)

    def test_uplink_success_uses_remote_dns_and_always_cleans_container(self):
        self.root.mkdir()
        listener = mock.MagicMock()
        listener.__enter__.return_value = listener
        listener.getsockname.return_value = ("127.0.0.1", 12345)

        def run(arguments, **kwargs):
            return "9.9.9.9" if arguments[0] == "curl" else "fake-container"

        with mock.patch.object(cascade.socket, "socket", return_value=listener), \
                mock.patch.object(cascade.socket, "create_connection", return_value=mock.MagicMock()), \
                mock.patch.object(cascade, "run_command", side_effect=run) as command:
            self.deployment.test_uplink(remote(), fixture()["image"])
        calls = [call.args[0] for call in command.call_args_list]
        curl = next(arguments for arguments in calls if arguments[0] == "curl")
        self.assertIn("--socks5-hostname", curl)
        self.assertIn("127.0.0.1:12345", curl)
        self.assertEqual(calls[-1][:3], ["docker", "rm", "-f"])
        name = calls[0][calls[0].index("--name") + 1]
        self.assertEqual(calls[-1][-1], name)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_uplink_failure_removes_test_container_without_live_configuration(self):
        self.root.mkdir()
        listener = mock.MagicMock()
        listener.__enter__.return_value = listener
        listener.getsockname.return_value = ("127.0.0.1", 12345)

        def run(arguments, **kwargs):
            if arguments[0] == "curl":
                raise cascade.SetupError("upstream failed")
            return "fake-container"

        with mock.patch.object(cascade.socket, "socket", return_value=listener), \
                mock.patch.object(cascade.socket, "create_connection", return_value=mock.MagicMock()), \
                mock.patch.object(cascade, "run_command", side_effect=run) as command, \
                self.assertRaisesRegex(cascade.SetupError, "армянского канала не прошла"):
            self.deployment.test_uplink(remote(), fixture()["image"])
        self.assertEqual(command.call_args_list[-1].args[0][:3], ["docker", "rm", "-f"])
        self.assertEqual(list(self.root.iterdir()), [])
        self.activator.assert_not_called()


if __name__ == "__main__":
    unittest.main()
