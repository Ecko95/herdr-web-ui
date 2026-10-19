import asyncio
import json
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

PATH = Path(__file__).with_name("motoko-hermes.py")
BINDING = {"home":"/fiction/.hermes/profiles/alpha", "profile":"alpha", "bank":"alpha", "workspace":"/fiction/workspace", "endpoint":"http://127.0.0.1:7434", "revision":"a" * 40}

class BridgeTests(unittest.TestCase):
    def load(self):
        self.assertTrue(PATH.is_file(), "Python bridge implementation is absent")
        spec = importlib.util.spec_from_file_location("fake_test_motoko_bridge", PATH)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module

    def test_old_runtime_cannot_receive_new_fields(self):
        module = self.load(); calls = []
        class Client:
            async def rpc(self, method, **params):
                calls.append((method, params)); return {"profile_id":BINDING["home"], "instance_id":"instance-alpha", "authority_epoch":7, "capabilities":[]}
        bridge = module.HermesBridge(Client(), BINDING, SimpleNamespace(profile_id=BINDING["home"], instance_id="instance-alpha", authority_epoch=7, code_sha=BINDING["revision"]))
        with self.assertRaisesRegex(module.BridgeError, "incompatible_runtime"): asyncio.run(bridge.initialize())
        self.assertEqual([m for m, p in calls], ["runtime.describe"])

    def client(self, module):
        calls = []
        requirement = {"provider":"mnemosyne", "home_id":BINDING["home"], "bank":"alpha"}
        class Client:
            async def rpc(self, method, **params):
                calls.append((method, params))
                if method == "runtime.describe": return {"profile_id":BINDING["home"], "instance_id":"instance-alpha", "authority_epoch":7, "capabilities":["motoko-required-memory-v1"]}
                if method == "session.create": return {"session_id":"session-alpha", "authority_epoch":7, "replay_epoch":"epoch-one", "last_sequence":0}
                if method == "session.memory_status": return {"state":"uninitialized", "required_memory":requirement, "binding":None}
                if method == "prompt.submit": raise OSError("private diagnostic with credential")
                if method in {"prompt.receipt", "prompt.resolve_unknown"}: return {"status":"started", "execution_generation":4, "admission_id":"admission-alpha", "authority_epoch":7,"ref":{"profile_id":BINDING["home"],"session_id":"session-alpha"}}
                return {}
        bridge = module.HermesBridge(Client(), BINDING, SimpleNamespace(profile_id=BINDING["home"], instance_id="instance-alpha", authority_epoch=7, code_sha=BINDING["revision"]))
        return bridge, calls

    def test_creation_uses_fixed_scope_and_canonical_request_identity(self):
        module = self.load(); bridge, calls = self.client(module)
        async def run():
            await bridge.initialize(); return await bridge.command({"operation":"create", "requestId":"1" * 32})
        result = asyncio.run(run()); self.assertEqual(result["session_id"], "session-alpha")
        self.assertEqual(calls[-1], ("session.create", {"_timeout":5, "request_id":"1" * 32, "source":"gui", "cwd":BINDING["workspace"], "required_memory":{"provider":"mnemosyne", "profile":"alpha"}}))
        with self.assertRaises(module.BridgeError): asyncio.run(bridge.command({"operation":"create", "requestId":"1" * 32, "home":"/fiction/other"}))

    def test_unknown_submit_never_retries_or_leaks_diagnostics(self):
        module = self.load(); bridge, calls = self.client(module)
        async def run():
            await bridge.initialize(); await bridge.command({"operation":"create", "requestId":"1" * 32})
            return await bridge.command({"operation":"submit", "sessionId":"session-alpha", "submissionId":"2" * 32, "text":"fictional input", "apiText":"snapshot\nfictional input"})
        with self.assertRaisesRegex(module.BridgeError, "outcome_unknown") as error: asyncio.run(run())
        self.assertNotIn("credential", str(error.exception))
        self.assertEqual(len([m for m,p in calls if m == "prompt.submit"]), 1)
        with self.assertRaises(module.BridgeError): asyncio.run(bridge.command({"operation":"resume", "sessionId":"unowned-session"}))

    def test_stop_uses_the_owned_admission_generation(self):
        module = self.load(); bridge, calls = self.client(module)
        async def run():
            await bridge.initialize(); await bridge.command({"operation":"create", "requestId":"1" * 32})
            return await bridge.command({"operation":"stop", "sessionId":"session-alpha", "admissionId":"admission-alpha"})
        result = asyncio.run(run()); self.assertEqual(result["status"], "started")
        self.assertIn(("session.interrupt", {"_timeout":5, "session_id":"session-alpha", "execution_generation":4}), calls)

    def test_explicit_discovery_never_starts_or_falls_back(self):
        from contextlib import asynccontextmanager
        module = self.load(); bridge, calls = self.client(module)
        endpoint = bridge.endpoint
        endpoint.api_origin = BINDING["endpoint"]
        seen = []
        def discover(home, timeout):
            self.assertEqual(str(home), BINDING["home"]); self.assertEqual(timeout, 5)
            return SimpleNamespace(state="ready", endpoint=endpoint)
        @asynccontextmanager
        async def connect(**kwargs):
            seen.append(kwargs); yield bridge.client
        async def run():
            async with module.open_bridge(BINDING, "fiction-owner", [], discover, connect) as opened:
                self.assertTrue(opened.compatible)
        asyncio.run(run())
        self.assertEqual(seen, [{"endpoint":endpoint, "subject":"fiction-owner"}])
        def unavailable(home, timeout): return SimpleNamespace(state="absent", endpoint=None)
        async def refuse():
            async with module.open_bridge(BINDING, "fiction-owner", [], unavailable, connect):
                self.fail("unavailable runtime connected")
        with self.assertRaisesRegex(module.BridgeError, "runtime_unavailable"): asyncio.run(refuse())
        self.assertEqual(len(seen), 1)

class ProtocolTests(unittest.TestCase):
    load = BridgeTests.load
    client = BridgeTests.client
    def test_protocol_reads_events_while_command_waits(self):
        module = self.load(); bridge, calls = self.client(module)
        async def run():
            bridge.client.events = asyncio.Queue()
            bridge.owned.add("session-alpha")
            await bridge.initialize()
            output = []; release = asyncio.Event(); lines = asyncio.Queue()
            async def command(value):
                await release.wait(); return {"ok":True}
            bridge.command = command
            async def read(limit): return await lines.get()
            async def write(value):
                output.append(value)
                if value.get("kind") == "event": release.set()
            await lines.put(b'{"id":"request-one","command":{"operation":"resume","sessionId":"session-alpha"}}\n')
            await lines.put(b'')
            await bridge.client.events.put({"method":"event","params":{"session_id":"session-alpha","type":"message.delta","seq":1,"replay_epoch":"epoch-one","payload":{"delta":"hello"}}})
            await asyncio.wait_for(module.run_protocol(bridge, read, write), 1)
            self.assertEqual(output[0]["kind"], "event")
            self.assertEqual(output[1], {"kind":"result","id":"request-one","result":{"ok":True}})
        asyncio.run(run())

    def test_malformed_lines_do_not_reuse_previous_request_id(self):
        module = self.load(); bridge, calls = self.client(module)
        async def run():
            await bridge.initialize(); bridge.client.events = asyncio.Queue(); output = []
            lines = iter([b'{"id":"good","command":{"operation":"create","requestId":"' + b'1'*32 + b'"}}\n', b'{broken\n', b'[]\n', b'{"id":{},"command":{}}\n', b''])
            async def read(limit): return next(lines)
            async def write(value): output.append(value)
            await asyncio.wait_for(module.run_protocol(bridge, read, write), 1)
            self.assertEqual(output[0]["id"], "good")
            self.assertEqual(output[1:], [{"kind":"error","id":None,"code":"invalid_request"}]*3)
        asyncio.run(run())

    def test_partial_or_oversized_line_ends_protocol_before_rpc(self):
        module = self.load()
        for line in [b'x'*32769, b'{"id":"partial"}']:
            bridge, calls = self.client(module)
            async def run():
                await bridge.initialize(); bridge.client.events = asyncio.Queue(); output = []
                async def read(limit): return line
                async def write(value): output.append(value)
                await asyncio.wait_for(module.run_protocol(bridge, read, write), 1)
                self.assertEqual(output, [{"kind":"error","id":None,"code":"input_too_large"}])
            asyncio.run(run()); self.assertEqual(len(calls), 1)

    def test_events_refuse_foreign_sessions_and_detect_gaps(self):
        module = self.load(); bridge, calls = self.client(module); bridge.owned.add("session-alpha")
        def event(seq=1, epoch="epoch-one", session="session-alpha", kind="message.delta"):
            return {"method":"event","params":{"session_id":session,"type":kind,"seq":seq,"replay_epoch":epoch,"payload":{"delta":"hello"}}}
        self.assertIsNone(bridge.event(event(session="foreign")))
        self.assertEqual(bridge.event(event())["kind"], "event")
        self.assertIsNone(bridge.event(event()))
        self.assertEqual(bridge.event(event(3))["code"], "resync_required")
        self.assertIsNone(bridge.event(event(4)))
        bridge.snapshot({"session_id":"session-alpha","replay_epoch":"epoch-two","last_sequence":10,"authority_epoch":7})
        self.assertIsNone(bridge.event(event(10,"epoch-two")))
        self.assertEqual(bridge.event(event(11,"epoch-two"))["kind"], "event")
        self.assertEqual(bridge.event(event(12,"other-epoch"))["code"], "resync_required")

    def test_lost_turn_acknowledgement_uses_recorded_identity_only(self):
        module=self.load();bridge,calls=self.client(module)
        async def run():
            await bridge.initialize();await bridge.command({"operation":"create","requestId":"1"*32})
            await bridge.command({"operation":"resolve","sessionId":"session-alpha","admissionId":"admission-alpha","generation":4})
        asyncio.run(run())
        self.assertEqual(calls[-1],("prompt.resolve_unknown",{"_timeout":5,"session_id":"session-alpha","admission_id":"admission-alpha","execution_generation":4}))
        self.assertFalse(any(m=="prompt.submit" for m,p in calls))

    def test_failed_provider_status_is_visible_but_cannot_admit_input(self):
        module=self.load();bridge,calls=self.client(module);original=bridge.client.rpc
        async def rpc(method,**params):
            if method=="session.memory_status":return {"state":"failed","required_memory":{"provider":"mnemosyne","home_id":BINDING["home"],"bank":"alpha"},"binding":None}
            return await original(method,**params)
        bridge.client.rpc=rpc
        async def run():
            await bridge.initialize();await bridge.command({"operation":"create","requestId":"1"*32})
            self.assertEqual((await bridge.command({"operation":"memory","sessionId":"session-alpha"}))["state"],"failed")
            with self.assertRaisesRegex(module.BridgeError,"memory_binding_unverified"):
                await bridge.command({"operation":"submit","sessionId":"session-alpha","submissionId":"2"*32,"text":"hello","apiText":"snapshot\nhello"})
        asyncio.run(run());self.assertFalse(any(m=="prompt.submit" for m,p in calls))

    def test_create_sets_snapshot_watermark(self):
        module=self.load(); bridge,calls=self.client(module)
        original=bridge.client.rpc
        async def rpc(method,**params):
            if method=="session.create":return {"session_id":"session-alpha","replay_epoch":"epoch-one","last_sequence":5,"authority_epoch":7}
            return await original(method,**params)
        bridge.client.rpc=rpc
        async def run():
            await bridge.initialize();await bridge.command({"operation":"create","requestId":"1"*32})
        asyncio.run(run())
        self.assertEqual(bridge.watermarks.get("session-alpha"),("epoch-one",5))

    def test_event_privacy_and_bounds(self):
        module = self.load(); bridge, calls = self.client(module); bridge.owned.add("session-alpha")
        event={"method":"event","params":{"session_id":"session-alpha","type":"thinking.delta","seq":1,"replay_epoch":"epoch-one","payload":{"text":"private reasoning"}}}
        self.assertIsNone(bridge.event(event))
        event["params"].update(type="message.delta",seq=2,payload={"delta":"x"*65536})
        self.assertEqual(bridge.event(event)["code"], "resync_required")

class ReconciliationTests(unittest.TestCase):
    load = BridgeTests.load
    client = BridgeTests.client

    def test_snapshot_does_not_regress_an_observed_watermark(self):
        module=self.load();bridge,calls=self.client(module);bridge.owned.add("session-alpha")
        snapshot={"session_id":"session-alpha","authority_epoch":7,"replay_epoch":"epoch-one","last_sequence":2}
        bridge.snapshot(snapshot)
        bridge.snapshot({**snapshot,"last_sequence":1})
        self.assertEqual(bridge.watermarks["session-alpha"],("epoch-one",2))

    def test_gap_during_resume_stays_unresolved_until_another_snapshot(self):
        module=self.load();bridge,calls=self.client(module);bridge.owned.add("session-alpha")
        original=bridge.client.rpc
        async def rpc(method,**params):
            if method=="session.resume":
                bridge.event({"method":"event","params":{"session_id":"session-alpha","replay_epoch":"epoch-one","seq":3,"type":"message.delta","payload":{"text":"missing earlier event"}}})
                return {"session_id":"session-alpha","authority_epoch":7,"replay_epoch":"epoch-one","last_sequence":1}
            return await original(method,**params)
        bridge.client.rpc=rpc
        async def run():
            await bridge.initialize();await bridge.command({"operation":"resume","sessionId":"session-alpha"})
        asyncio.run(run());self.assertIn("session-alpha",bridge.gaps)
        bridge.snapshot({"session_id":"session-alpha","authority_epoch":7,"replay_epoch":"epoch-one","last_sequence":3})
        self.assertNotIn("session-alpha",bridge.gaps)

    def test_settled_controls_cross_the_approved_event_boundary(self):
        module=self.load();bridge,calls=self.client(module);bridge.owned.add("session-alpha")
        for seq,kind in enumerate(["approval.settled","clarify.settled"],1):
            event={"method":"event","params":{"session_id":"session-alpha","replay_epoch":"epoch-one","seq":seq,"type":kind,"payload":{"prompt_id":"prompt-one"}}}
            self.assertEqual(bridge.event(event)["event"]["type"],kind)

    def test_foreign_receipt_cannot_authorize_a_stop(self):
        module=self.load();bridge,calls=self.client(module);original=bridge.client.rpc
        async def rpc(method,**params):
            if method=="prompt.receipt":return {"admission_id":"foreign-admission","status":"started","execution_generation":4,"authority_epoch":7,"ref":{"profile_id":BINDING["home"],"session_id":"foreign-session"}}
            return await original(method,**params)
        bridge.client.rpc=rpc
        async def run():
            await bridge.initialize();await bridge.command({"operation":"create","requestId":"1"*32})
            await bridge.command({"operation":"stop","sessionId":"session-alpha","admissionId":"admission-alpha"})
        with self.assertRaisesRegex(module.BridgeError,"invalid_response"):asyncio.run(run())
        self.assertFalse(any(method=="session.interrupt" for method,params in calls))

class ContextTests(unittest.TestCase):
    load = BridgeTests.load
    client = BridgeTests.client

    def test_canonical_submit_preserves_text_and_model_input(self):
        module=self.load();bridge,calls=self.client(module);original=bridge.client.rpc
        async def rpc(method,**params):
            if method=="prompt.submit":
                calls.append((method,params));return {"status":"queued","admission_id":"admission-alpha","authority_epoch":7,"ref":{"profile_id":BINDING["home"],"session_id":"session-alpha"}}
            return await original(method,**params)
        bridge.client.rpc=rpc
        async def run():
            await bridge.initialize();await bridge.command({"operation":"create","requestId":"1"*32})
            await bridge.command({"operation":"submit","sessionId":"session-alpha","submissionId":"2"*32,"text":"hello","apiText":"snapshot\nhello"})
        asyncio.run(run())
        self.assertEqual([p for m,p in calls if m=="prompt.submit"],[{"_timeout":5,"session_id":"session-alpha","submission_id":"2"*32,"text":"hello","api_text":"snapshot\nhello"}])

    def test_missing_or_invalid_context_refuses_before_rpc(self):
        module=self.load();bridge,calls=self.client(module)
        async def run():
            await bridge.initialize();await bridge.command({"operation":"create","requestId":"1"*32})
            for extra in [{},{"apiText":None},{"apiText":""},{"apiText":"x"*1000001}]:
                with self.assertRaises(module.BridgeError):
                    await bridge.command({"operation":"submit","sessionId":"session-alpha","submissionId":"2"*32,"text":"hello",**extra})
        asyncio.run(run());self.assertFalse(any(m=="prompt.submit" for m,p in calls))

    def test_protocol_measures_complete_utf8_submit_frames(self):
        module=self.load()
        for operation,count,accepted in [("submit",12000,True),("memory",12000,False),("submit",180000,False)]:
            bridge,calls=self.client(module)
            async def run():
                await bridge.initialize();bridge.client.events=asyncio.Queue();output=[];seen=[]
                async def command(value):seen.append(value);return {"ok":True}
                bridge.command=command
                frame=(json.dumps({"id":"context","command":{"operation":operation,"apiText":"漢字"*count}},ensure_ascii=False)+"\n").encode()
                lines=iter([frame,b""])
                async def read(limit):return next(lines)
                async def write(value):output.append(value)
                await asyncio.wait_for(module.run_protocol(bridge,read,write),1)
                self.assertEqual(bool(seen),accepted)
                self.assertEqual(output[0]["kind"],"result" if accepted else "error")
            asyncio.run(run())

if __name__ == "__main__": unittest.main()
