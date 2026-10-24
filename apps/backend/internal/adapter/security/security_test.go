package security

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"testing"
	"time"

	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/google/uuid"
)

func TestArgon2idRoundTrip(t *testing.T) {
	hasher := Argon2id{Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32}
	encoded, err := hasher.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	ok, err := hasher.Verify("correct horse battery staple", encoded)
	if err != nil || !ok {
		t.Fatalf("expected password to verify: ok=%v err=%v", ok, err)
	}
	ok, err = hasher.Verify("wrong password", encoded)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("wrong password verified")
	}
}

func TestOpaqueTokenIs256BitsAndHashable(t *testing.T) {
	manager := OpaqueTokenManager{}
	raw, originalHash, err := manager.New()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("token is not 256 bits: len=%d err=%v", len(decoded), err)
	}
	recomputed, err := manager.Hash(raw)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(originalHash) != hex.EncodeToString(recomputed) {
		t.Fatal("token hashes differ")
	}
}

func TestRFC8785ReferenceVector(t *testing.T) {
	input := []byte(`{"z":0,"c":1E30,"b":4.50,"a":"€"}`)
	got, err := jsoncanonicalizer.Transform(input)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"a":"€","b":4.5,"c":1e+30,"z":0}`
	if string(got) != want {
		t.Fatalf("canonical JSON mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestCanonicalMutationGoldenVector(t *testing.T) {
	baseRevision := 7
	mutation := domain.SyncMutation{
		OperationID:     "11111111-1111-4111-8111-111111111111",
		Aggregate:       "transaction",
		AggregateID:     "01ARZ3NDEKTSV4RRFFQ69G5FAV",
		Action:          "correct",
		BaseRevision:    &baseRevision,
		OriginSessionID: uuid.MustParse("22222222-2222-4222-8222-222222222222"),
		OriginActorID:   uuid.MustParse("33333333-3333-4333-8333-333333333333"),
		TerminalID:      uuid.MustParse("44444444-4444-4444-8444-444444444444"),
		OccurredAt:      time.Date(2026, 7, 24, 3, 4, 5, 0, time.UTC),
		Payload:         []byte(`{"reason":"Jumlah diperbaiki","id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","items":[{"quantity":2,"packageRevision":1,"packageId":"00000000-0000-4000-8000-000000000001"}]}`),
	}
	got, err := CanonicalMutation(mutation)
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"action":"correct","aggregate":"transaction","aggregateId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","baseRevision":7,"occurredAt":"2026-07-24T03:04:05.000Z","operationId":"11111111-1111-4111-8111-111111111111","originActorId":"33333333-3333-4333-8333-333333333333","originSessionId":"22222222-2222-4222-8222-222222222222","payload":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","items":[{"packageId":"00000000-0000-4000-8000-000000000001","packageRevision":1,"quantity":2}],"reason":"Jumlah diperbaiki"},"terminalId":"44444444-4444-4444-8444-444444444444"}`
	if string(got) != want {
		t.Fatalf("signed projection mismatch\n got: %s\nwant: %s", got, want)
	}

	seed, _ := hex.DecodeString("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
	privateKey := ed25519.NewKeyFromSeed(seed)
	signature := ed25519.Sign(privateKey, got)
	mutation.Signature = base64.StdEncoding.EncodeToString(signature)
	const wantSignature = "g/c9NoDQdK+cE0t6NN5WKJdARDSzwxgSSNIUwD2L5EJrcJA1BR7YcI4cNwtHAkMVy6j7E8AkmvgMiN2lpjr0AA=="
	if mutation.Signature != wantSignature {
		t.Fatalf("golden signature mismatch\n got: %s\nwant: %s", mutation.Signature, wantSignature)
	}
	if err := VerifyMutation(privateKey.Public().(ed25519.PublicKey), mutation); err != nil {
		t.Fatalf("golden signature did not verify: %v", err)
	}
}

func TestArgon2idNeedsRehashOnlyForOutdatedParameters(t *testing.T) {
	legacy := Argon2id{Memory: 16 * 1024, Iterations: 3, Parallelism: 1, SaltLength: 16, KeyLength: 32}
	current := Argon2id{Memory: 8 * 1024, Iterations: 2, Parallelism: 1, SaltLength: 16, KeyLength: 32}
	legacyHash, err := legacy.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	currentHash, err := current.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !current.NeedsRehash(legacyHash) {
		t.Fatal("legacy hash was not flagged for rehash")
	}
	if current.NeedsRehash(currentHash) || current.NeedsRehash("not-an-argon2id-hash") {
		t.Fatal("current or unparseable hash was flagged for rehash")
	}
}
