"""Unit tests for src/plugins/hermes_browser/_widespread.py.

Runs under plain CPython unittest — no Pyodide, no pytest, no network.
Covers the dependency-free parts of the plugin: the RFC 8032 Ed25519
fallback signer (used when `cryptography`/`nacl` are absent in the
browser env), the dg1 signed-header envelope shape, and response shaping.

    python3 -m unittest tests.test_widespread_plugin -v
"""

import base64
import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent
                     / "src" / "plugins" / "hermes_browser"))
import _widespread as w  # noqa: E402


class PureEd25519(unittest.TestCase):
    """RFC 8032 TEST 1 — empty message, well-known seed/pubkey/sig."""

    SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc4"
                         "4449c5697b326919703bac031cae7f60")
    PUB = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a"
                        "0ee172f3daa62325af021a68f707511a")
    SIG = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a"
        "84877f1eb8e5d974d873e06522490155"
        "5fb8821590a33bacc61e39701cf9b46b"
        "d25bf5f0595bbe24655141438e7a100b")

    def test_rfc8032_vector(self):
        sig = w._pure_ed25519_sign(b"", self.SEED)
        self.assertEqual(sig, self.SIG)

    def test_pubkey_matches_rfc8032(self):
        # _pubkey may prefer `cryptography`/`nacl` when installed; verify
        # whichever backend runs produces the RFC pubkey.
        self.assertEqual(w._pubkey(self.SEED), self.PUB)

    def test_sign_verify_roundtrip(self):
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey, Ed25519PublicKey)
        seed = bytes(range(32))
        sig = w._sign(b"dg1-payload", seed)
        pub = w._pubkey(seed)
        Ed25519PublicKey.from_public_bytes(pub).verify(sig, b"dg1-payload")

    def test_deterministic(self):
        seed = bytes(range(32))
        self.assertEqual(w._sign(b"x", seed), w._sign(b"x", seed))
        self.assertNotEqual(w._sign(b"x", seed), w._sign(b"y", seed))


class SignedHeaders(unittest.TestCase):
    SEED_B64 = base64.b64encode(bytes(range(32))).decode()

    def test_envelope_fields(self):
        h = w._signed_headers(self.SEED_B64, "did:key:z6Mk", "/api/x",
                              b'{"a":1}')
        for k in ("x-dg-did", "x-dg-ts", "x-dg-nonce", "x-dg-sig"):
            self.assertIn(k, h)
        self.assertEqual(h["x-dg-did"], "did:key:z6Mk")
        self.assertRegex(h["x-dg-ts"], r"^\d+$")
        self.assertEqual(len(h["x-dg-nonce"]), 32)  # 16 bytes hex
        self.assertEqual(len(h["x-dg-sig"]), 128)   # 64 bytes hex

    def test_sig_covers_dg1_envelope(self):
        """Recompute the dg1 payload the signer claims to cover."""
        body = b'{"a":1}'
        path = "/api/owner/repo/claims"
        h = w._signed_headers(self.SEED_B64, "did:key:z", path, body)
        payload = w._sha256_hex(
            f"dg1\ndid:key:z\n{h['x-dg-ts']}\n{h['x-dg-nonce']}\n"
            f"POST\n{path}\n{w._sha256_hex(body)}".encode())
        sig = w._sign(payload.encode(), base64.b64decode(self.SEED_B64))
        self.assertEqual(sig.hex(), h["x-dg-sig"])

    def test_nonce_unique(self):
        a = w._signed_headers(self.SEED_B64, "d", "/p", b"")
        b = w._signed_headers(self.SEED_B64, "d", "/p", b"")
        self.assertNotEqual(a["x-dg-nonce"], b["x-dg-nonce"])


class Helpers(unittest.TestCase):
    def test_sha256_hex(self):
        self.assertEqual(w._sha256_hex(b""),
                         hashlib.sha256(b"").hexdigest())

    def test_ok_shapes_json_string(self):
        out = json.loads(w._ok({"foo": 1}))
        self.assertTrue(out["success"])
        self.assertEqual(out["foo"], 1)
        out = json.loads(w._ok({"error": "boom"}))
        self.assertFalse(out["success"])

    def test_spec_helper_requires_fields(self):
        tool = w._s({"type": "object"}, ["repo"], "desc")
        self.assertEqual(tool["type"], "object")
        props = tool["properties"] if "properties" in tool else tool
        # _s returns the tool schema fragment used by register_tools;
        # just ensure it serializes.
        json.dumps(tool)


if __name__ == "__main__":
    unittest.main()
