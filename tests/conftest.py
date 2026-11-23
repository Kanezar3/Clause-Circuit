import sys
from pathlib import Path
from types import ModuleType
import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


class UserError(Exception):
    pass


class Address(str):
    def __new__(cls, val: str):
        return super().__new__(cls, str(val).lower())

    @property
    def as_hex(self) -> str:
        return str(self)


class u256(int):
    def __new__(cls, val: int = 0):
        v = int(val)
        if v < 0:
            raise OverflowError("u256 cannot be negative")
        return super().__new__(cls, v)

    def __add__(self, other):
        return u256(int(self) + int(other))

    def __sub__(self, other):
        return u256(int(self) - int(other))


class TreeMap(dict):
    def __class_getitem__(cls, item):
        return cls


class DynArray(list):
    def __class_getitem__(cls, item):
        return cls


class Contract:
    def __init__(self):
        for attr_name, ann in getattr(self.__class__, "__annotations__", {}).items():
            if not hasattr(self, attr_name):
                if ann is TreeMap or getattr(ann, "__origin__", None) is TreeMap:
                    setattr(self, attr_name, TreeMap())
                elif ann is DynArray or getattr(ann, "__origin__", None) is DynArray:
                    setattr(self, attr_name, DynArray())


class Return:
    def __init__(self, calldata):
        self.calldata = calldata


class MockWebResponse:
    def __init__(self, status: int = 200, body: bytes = b""):
        self.status = status
        self.status_code = status
        self.body = body


mock_web_responses: dict[str, MockWebResponse] = {}
mock_llm_responses: list = []
emitted_transfers: list[dict] = []


class _MockMessage:
    def __init__(self):
        self.sender_address = Address("0x1111111111111111111111111111111111111111")
        self.value = u256(0)
        self.timestamp = 1795000000


class _MockGL:
    def __init__(self):
        self.Contract = Contract
        self.message = _MockMessage()
        self.message_raw = {"datetime": "2026-11-23T10:00:00Z"}
        self.adversarial_leader_fn = None

        class _Public:
            @staticmethod
            def write(fn):
                return fn

            @staticmethod
            def view(fn):
                return fn

        _Public.write.payable = staticmethod(lambda fn: fn)
        self.public = _Public

        class _Evm:
            @staticmethod
            def contract_interface(cls):
                class _Wrapper:
                    def __init__(self, addr):
                        self.addr = _norm(addr)

                    def emit_transfer(self, value=u256(0), **kwargs):
                        emitted_transfers.append(
                            {"to": self.addr, "value": int(value)}
                        )

                return _Wrapper

        self.evm = _Evm

        class _VM:
            UserError = UserError
            Return = Return

            @staticmethod
            def run_nondet_unsafe(leader_fn, validator_fn):
                leader_out = leader_fn()
                if gl_mock.adversarial_leader_fn is not None:
                    leader_out = gl_mock.adversarial_leader_fn(leader_out)
                ok = validator_fn(Return(leader_out))
                if not ok:
                    raise UserError("CONSENSUS_VALIDATION_FAILED")
                return leader_out

        self.vm = _VM

        class _Web:
            @staticmethod
            def get(url: str):
                if url not in mock_web_responses:
                    raise RuntimeError(f"UNMOCKED_URL:{url}")
                resp = mock_web_responses[url]
                if isinstance(resp, Exception):
                    raise resp
                return resp

        class _Nondet:
            web = _Web

            @staticmethod
            def exec_prompt(prompt: str, response_format: str = "text"):
                if not mock_llm_responses:
                    raise RuntimeError("NO_MOCK_LLM_HANDLER")
                handler = mock_llm_responses[-1]
                return handler(prompt)

        self.nondet = _Nondet


def _norm(addr) -> str:
    if hasattr(addr, "as_hex"):
        return str(addr.as_hex).lower()
    return str(addr).lower()


gl_mock = _MockGL()

# Register mock genlayer module before importing contracts
genlayer_mod = ModuleType("genlayer")
genlayer_mod.gl = gl_mock
genlayer_mod.Address = Address
genlayer_mod.u256 = u256
genlayer_mod.TreeMap = TreeMap
genlayer_mod.DynArray = DynArray
genlayer_mod.__all__ = ["gl", "Address", "u256", "TreeMap", "DynArray"]
sys.modules["genlayer"] = genlayer_mod

ADDR_SPONSOR = Address("0x1111111111111111111111111111111111111111")
ADDR_BENEFICIARY = Address("0x2222222222222222222222222222222222222222")
ADDR_SOLVER = Address("0x3333333333333333333333333333333333333333")
ADDR_ATTACKER = Address("0x4444444444444444444444444444444444444444")


def set_sender(addr: Address):
    gl_mock.message.sender_address = addr


def set_value(val: int):
    gl_mock.message.value = u256(val)


def set_time(ts: int | None):
    if ts is None:
        gl_mock.message_raw = {}
        gl_mock.message.timestamp = None
    else:
        gl_mock.message_raw = {"datetime": int(ts)}
        gl_mock.message.timestamp = int(ts)


@pytest.fixture(autouse=True)
def reset_mocks():
    mock_web_responses.clear()
    mock_llm_responses.clear()
    emitted_transfers.clear()
    gl_mock.adversarial_leader_fn = None
    set_sender(ADDR_SPONSOR)
    set_value(0)
    set_time(1795000000)
    yield
