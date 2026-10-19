"""Private closed-operation bridge. Imports Hermes only in the explicitly launched entry point."""
import asyncio
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit


class BridgeError(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", value):
        raise BridgeError("invalid_request")
    return value


class HermesBridge:
    def __init__(self, client, binding, endpoint, owned_sessions=()):
        self.client = client
        self.binding = dict(binding)
        self.endpoint = endpoint
        self.owned = {identifier(value) for value in owned_sessions}
        self.compatible = False
        self.watermarks = {}
        self.gaps = set()
        self.gap_versions = {}

    def snapshot(self, result, gap_version=None):
        session = result.get("session_id")
        epoch, sequence = result.get("replay_epoch"), result.get("last_sequence")
        if (session not in self.owned or result.get("authority_epoch") != self.endpoint.authority_epoch
                or not isinstance(epoch, str) or not epoch or type(sequence) is not int or sequence < 0):
            raise BridgeError("invalid_response")
        previous = self.watermarks.get(session)
        self.watermarks[session] = (epoch, max(sequence, previous[1]) if previous and previous[0] == epoch else sequence)
        if gap_version is None or gap_version == self.gap_versions.get(session, 0):
            self.gaps.discard(session)

    def event(self, frame):
        if isinstance(frame, Exception):
            raise BridgeError("outcome_unknown")
        if not isinstance(frame, dict) or frame.get("method") != "event":
            return None
        event = frame.get("params")
        if not isinstance(event, dict) or event.get("session_id") not in self.owned:
            return None
        session = event["session_id"]
        if session in self.gaps:
            self.gap_versions[session] = self.gap_versions.get(session, 0) + 1
            return None
        epoch, sequence = event.get("replay_epoch"), event.get("seq")
        previous = self.watermarks.get(session)
        def gap():
            self.gaps.add(session)
            self.gap_versions[session] = self.gap_versions.get(session, 0) + 1
            return {"kind":"status", "sessionId":session, "code":"resync_required"}
        if (event.get("type") == "session.replay_gap" or not isinstance(epoch, str) or not epoch
                or type(sequence) is not int or sequence < 1
                or event.get("authority_epoch", self.endpoint.authority_epoch) != self.endpoint.authority_epoch):
            return gap()
        if previous:
            if epoch != previous[0]:
                return gap()
            if sequence <= previous[1]:
                return None
            if sequence != previous[1] + 1:
                return gap()
        elif sequence != 1:
            return gap()
        self.watermarks[session] = (epoch, sequence)
        if event.get("type") not in {"message.start", "message.delta", "message.interim", "message.complete",
                "tool.start", "tool.complete", "approval.request", "clarify.request", "approval.settled", "clarify.settled", "session.info"}:
            return None
        if len(json.dumps(event, ensure_ascii=False).encode("utf8")) > 65536:
            return gap()
        return {"kind":"event", "event":event}

    async def _rpc(self, method, **params):
        try:
            result = await self.client.rpc(method, _timeout=5, **params)
            if len(json.dumps(result, ensure_ascii=False).encode("utf8")) > 8 * 1024 * 1024:
                raise BridgeError("history_too_large")
            if not isinstance(result, dict):
                raise BridgeError("invalid_response")
            return result
        except BridgeError:
            raise
        except Exception:
            raise BridgeError("outcome_unknown") from None

    def receipt(self, result, session, admission=None):
        expected = {"profile_id": self.binding["home"], "session_id": session}
        if (result.get("ref") != expected or result.get("authority_epoch") != self.endpoint.authority_epoch
                or result.get("status") not in {"queued", "started", "unknown", "terminal"}
                or (admission is not None and result.get("admission_id") != admission)):
            raise BridgeError("invalid_response")
        identifier(result.get("admission_id"))
        return result

    async def initialize(self):
        result = await self._rpc("runtime.describe")
        expected = {"profile_id":self.binding["home"], "instance_id":self.endpoint.instance_id,
                    "authority_epoch":self.endpoint.authority_epoch}
        if (any(result.get(key) != value for key, value in expected.items())
                or self.endpoint.profile_id != self.binding["home"]
                or self.endpoint.code_sha != self.binding["revision"]
                or "motoko-required-memory-v1" not in result.get("capabilities", [])):
            raise BridgeError("incompatible_runtime")
        self.compatible = True
        return {"configured":True, "runtimeCompatible":True, "memory":"uninitialized"}

    async def memory_status(self, session):
        result = await self._rpc("session.memory_status", session_id=session)
        expected = {"provider":"mnemosyne", "home_id":self.binding["home"], "bank":self.binding["bank"]}
        if result.get("required_memory") != expected or result.get("state") not in {"uninitialized", "ready", "failed"}:
            raise BridgeError("memory_binding_unverified")
        if result["state"] == "ready":
            actual = result.get("binding")
            if (not isinstance(actual, dict) or any(actual.get(key) != value for key,value in expected.items())
                    or actual.get("state") != "ready" or not isinstance(actual.get("session_scope"), str)
                    or not actual["session_scope"].startswith("hermes_")):
                raise BridgeError("memory_binding_unverified")
        return result

    async def command(self, command):
        if not self.compatible:
            raise BridgeError("incompatible_runtime")
        if not isinstance(command, dict):
            raise BridgeError("invalid_request")
        operation = command.get("operation")
        fields = {
            "create":{"requestId"}, "resume":{"sessionId"}, "memory":{"sessionId"},
            "submit":{"sessionId","submissionId","text"}, "receipt":{"sessionId","admissionId"},
            "stop":{"sessionId","admissionId"}, "events":{"sessionId","replayEpoch","lastSequence"},
            "detach":{"sessionId","subscriptionId"}, "resolve":{"sessionId","admissionId","generation"},
            "approve":{"sessionId","promptId","generation","choice"},
            "clarify":{"sessionId","promptId","generation","answer"},
        }
        if operation not in fields or set(command) != fields[operation] | {"operation"}:
            raise BridgeError("invalid_request")
        if operation == "create":
            request_id = command["requestId"]
            if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id):
                raise BridgeError("invalid_request")
            result = await self._rpc("session.create", request_id=request_id, source="gui", cwd=self.binding["workspace"],
                                     required_memory={"provider":"mnemosyne", "profile":self.binding["profile"]})
            self.owned.add(identifier(result.get("session_id")))
            self.snapshot(result)
            return result
        session = identifier(command["sessionId"])
        if session not in self.owned:
            raise BridgeError("conversation_not_owned")
        if operation == "memory":
            return await self.memory_status(session)
        if operation == "resume":
            gap_version = self.gap_versions.get(session, 0)
            result = await self._rpc("session.resume", session_id=session)
            self.snapshot(result, gap_version)
            return result
        if operation == "submit":
            submission_id = command["submissionId"]
            text = command["text"]
            if (not isinstance(submission_id, str) or not re.fullmatch(r"[a-f0-9]{32}", submission_id)
                    or not isinstance(text, str) or not text.strip()):
                raise BridgeError("invalid_request")
            try:
                if len(text.encode("utf8")) > 16384:
                    raise BridgeError("input_too_large")
            except UnicodeError:
                raise BridgeError("invalid_request") from None
            if (await self.memory_status(session))["state"] == "failed":
                raise BridgeError("memory_binding_unverified")
            return self.receipt(await self._rpc("prompt.submit", session_id=session, text=text, submission_id=submission_id), session)
        if operation == "resolve":
            generation = command["generation"]
            if type(generation) is not int or generation < 1:
                raise BridgeError("invalid_request")
            admission = identifier(command["admissionId"])
            return self.receipt(await self._rpc("prompt.resolve_unknown", session_id=session,
                                   admission_id=admission, execution_generation=generation), session, admission)
        if operation in {"receipt", "stop"}:
            admission = identifier(command["admissionId"])
            receipt = self.receipt(await self._rpc("prompt.receipt", session_id=session, admission_id=admission, include_result=True), session, admission)
            if operation == "receipt":
                return receipt
            if receipt.get("status") == "queued":
                await self._rpc("prompt.cancel", session_id=session, admission_id=admission)
                receipt = self.receipt(await self._rpc("prompt.receipt", session_id=session, admission_id=admission, include_result=True), session, admission)
            if receipt.get("status") == "started":
                generation = receipt.get("execution_generation")
                if type(generation) is not int or generation < 1:
                    raise BridgeError("outcome_unknown")
                await self._rpc("session.interrupt", session_id=session, execution_generation=generation)
                receipt = self.receipt(await self._rpc("prompt.receipt", session_id=session, admission_id=admission, include_result=True), session, admission)
            return receipt
        if operation == "events":
            if type(command["lastSequence"]) is not int or command["lastSequence"] < 0:
                raise BridgeError("invalid_request")
            return await self._rpc("session.events.since", session_id=session, replay_epoch=identifier(command["replayEpoch"]), last_sequence=command["lastSequence"])
        if operation == "detach":
            return await self._rpc("session.detach", session_id=session, subscription_id=identifier(command["subscriptionId"]))
        generation = command["generation"]
        text_key = "choice" if operation == "approve" else "answer"
        text = command[text_key]
        if type(generation) is not int or generation < 1 or not isinstance(text, str) or len(text.encode("utf8")) > 16384:
            raise BridgeError("invalid_request")
        return await self._rpc("approval.respond" if operation == "approve" else "clarify.respond",
                               session_id=session, prompt_id=identifier(command["promptId"]),
                               execution_generation=generation, **{text_key:text})


@asynccontextmanager
async def open_bridge(binding, subject, owned_sessions, discover, connect):
    origin = urlsplit(binding["endpoint"])
    if (origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "::1"} or not origin.port
            or origin.username or origin.password or origin.query or origin.fragment or origin.path not in {"", "/"}):
        raise BridgeError("invalid_binding")
    discovery = await asyncio.to_thread(discover, Path(binding["home"]), timeout=5)
    endpoint = discovery.endpoint
    if discovery.state != "ready" or endpoint is None or endpoint.api_origin.rstrip("/") != binding["endpoint"].rstrip("/"):
        raise BridgeError("runtime_unavailable")
    async with connect(endpoint=endpoint, subject=subject) as client:
        bridge = HermesBridge(client, binding, endpoint, owned_sessions)
        await bridge.initialize()
        yield bridge


async def run_protocol(bridge, read, write):
    async def commands():
        while True:
            line = await read(32769)
            if not line:
                return
            if len(line) > 32768 or not line.endswith(b"\n"):
                await write({"kind":"error", "id":None, "code":"input_too_large"})
                return
            request_id = None
            try:
                command = json.loads(line)
                if not isinstance(command, dict) or set(command) != {"id", "command"}:
                    raise BridgeError("invalid_request")
                request_id = identifier(command["id"])
                result = await bridge.command(command["command"])
                await write({"kind":"result", "id":request_id, "result":result})
            except (ValueError, TypeError, UnicodeError) as error:
                code = str(error) if isinstance(error, BridgeError) else "invalid_request"
                await write({"kind":"error", "id":request_id, "code":code})
            except Exception:
                await write({"kind":"error", "id":request_id, "code":"outcome_unknown"})

    async def events():
        while True:
            frame = await bridge.client.events.get()
            result = bridge.event(frame)
            if result is not None:
                await write(result)

    command_task, event_task = asyncio.create_task(commands()), asyncio.create_task(events())
    try:
        done, _ = await asyncio.wait({command_task, event_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            await task
    except Exception:
        await write({"kind":"error", "id":None, "code":"outcome_unknown"})
    finally:
        for task in (command_task, event_task):
            task.cancel()
        for task in (command_task, event_task):
            with suppress(asyncio.CancelledError):
                await task


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def main():
    # Only the fixed private server launches this entry point with a sanitized environment.
    line = sys.stdin.buffer.readline(65537)
    if len(line) > 65536 or not line.endswith(b"\n"):
        raise BridgeError("invalid_binding")
    config = json.loads(line)
    binding = config["binding"]
    if str(Path(os.environ.get("HERMES_HOME", "")).resolve()) != binding["home"]:
        raise BridgeError("invalid_binding")
    from hermes_cli.profiles import resolve_profile_env, profile_matches_home
    if (str(Path(resolve_profile_env(binding["profile"])).resolve()) != binding["home"]
            or not profile_matches_home(binding["profile"], Path(binding["home"]))):
        raise BridgeError("invalid_binding")
    from hermes_cli.gateway_runtime import discover_gateway_endpoint
    from hermes_cli.gateway_client import connect_gateway
    async with open_bridge(binding, config["subject"], config["ownedSessions"], discover_gateway_endpoint, connect_gateway) as bridge:
        emit({"kind":"ready", "memory":"uninitialized"})
        async def read(limit):
            return await asyncio.to_thread(sys.stdin.buffer.readline, limit)
        output_lock = asyncio.Lock()
        async def write(value):
            async with output_lock:
                await asyncio.to_thread(emit, value)
        await run_protocol(bridge, read, write)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except BridgeError as error:
        emit({"kind":"error", "code":str(error)})
    except Exception:
        emit({"kind":"error", "code":"runtime_unavailable"})
