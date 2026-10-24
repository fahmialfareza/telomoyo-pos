package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2Slots bounds how many Argon2id derivations run at once. Each one
// allocates its full memory cost (19 MiB by default, 64 MiB for older
// hashes), so unbounded login bursts become container memory spikes.
var argon2Slots = make(chan struct{}, 4)

// SetArgon2Concurrency resizes the derivation limit. Call it once at startup,
// before any Hash or Verify runs.
func SetArgon2Concurrency(n int) {
	if n < 1 {
		n = 1
	}
	argon2Slots = make(chan struct{}, n)
}

func idKey(password, salt []byte, iterations, memory uint32, parallelism uint8, keyLength uint32) []byte {
	argon2Slots <- struct{}{}
	defer func() { <-argon2Slots }()
	return argon2.IDKey(password, salt, iterations, memory, parallelism, keyLength)
}

type Argon2id struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	SaltLength  uint32
	KeyLength   uint32
}

// DefaultArgon2id follows the OWASP minimum (m=19 MiB, t=2, p=1). Verify reads
// the parameters from each stored hash, so older 64 MiB hashes keep working.
func DefaultArgon2id() Argon2id {
	return Argon2id{
		Memory:      19 * 1024,
		Iterations:  2,
		Parallelism: 1,
		SaltLength:  16,
		KeyLength:   32,
	}
}

func (a Argon2id) Hash(password string) (string, error) {
	salt := make([]byte, a.SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("read password salt: %w", err)
	}
	key := idKey([]byte(password), salt, a.Iterations, a.Memory, a.Parallelism, a.KeyLength)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		a.Memory,
		a.Iterations,
		a.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

func (a Argon2id) Verify(password, encoded string) (bool, error) {
	var memory, iterations uint32
	var parallelism uint8
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false, fmt.Errorf("invalid argon2id encoding")
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false, fmt.Errorf("parse argon2id parameters: %w", err)
	}
	if memory < 8*1024 || memory > 1024*1024 || iterations < 1 || iterations > 20 || parallelism < 1 || parallelism > 16 {
		return false, fmt.Errorf("argon2id parameters outside supported bounds")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < 8 || len(salt) > 64 {
		return false, fmt.Errorf("invalid argon2id salt")
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(expected) < 16 || len(expected) > 128 {
		return false, fmt.Errorf("invalid argon2id hash")
	}
	actual := idKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}
