package port

import (
	"context"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/google/uuid"
)

// SessionPolicyRepository creates immutable capability-bound sessions without
// changing the Repository contract required by historical clients and fixtures.
type SessionPolicyRepository interface {
	CreateAccountSessionWithProtocol(context.Context, uuid.UUID, []byte, int) (domain.Principal, error)
	UpgradeSession(context.Context, domain.Principal, []byte, []byte, int) (domain.Principal, error)
}

// VerifiedLoginSession contains an already-verified credential snapshot, not a
// raw password. The repository must compare the snapshot under an account lock
// held through session creation so password recovery cannot be bypassed by an
// in-flight login. Credential snapshots must never be audited or logged.
type VerifiedLoginSession struct {
	UserID               uuid.UUID
	VerifiedPasswordHash string
	TokenHash            []byte
	ProtocolVersion      int
	// Legacy clients enter the initial tenant directly; modern clients enter
	// account context and select a tenant through the context exchange API.
	TerminalID  *uuid.UUID
	DataSpaceID uuid.UUID
}

type VerifiedLoginSessionRepository interface {
	CreateVerifiedLoginSession(context.Context, VerifiedLoginSession) (domain.Principal, error)
}

// PasswordRehashPolicy is optionally implemented by a PasswordHasher to flag
// hashes encoded with outdated cost parameters.
type PasswordRehashPolicy interface {
	NeedsRehash(encoded string) bool
}

// PasswordHashUpgradeRepository re-encodes an unchanged password. It must only
// replace the exact verified hash and must not revoke sessions, because the
// credential itself is the same.
type PasswordHashUpgradeRepository interface {
	UpgradePasswordHash(ctx context.Context, userID uuid.UUID, verifiedHash, upgradedHash string) error
}
