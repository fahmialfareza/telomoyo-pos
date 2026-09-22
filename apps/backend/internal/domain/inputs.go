package domain

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ulidPattern            = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
	qrisPayloadHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type LoginInput struct {
	ClientProtocolVersion int
	Username              string
	Password              string
	InstallationID        *uuid.UUID
	IPAddress             string
}

type LoginResult struct {
	Token     string    `json:"token"`
	Principal Principal `json:"user"`
}

type SwitchModeInput struct {
	Mode DataMode `json:"mode"`
}

type ResetSandboxInput struct {
	ExpectedGeneration int64  `json:"expectedGeneration"`
	Confirmation       string `json:"confirmation"`
}

type ConfigureSandboxInput struct {
	Enabled *bool `json:"enabled"`
}

type CreateUserInput struct {
	FullName          string
	Username          string
	Role              Role
	TemporaryPassword string
}

type UpdateUserInput struct {
	FullName *string
	Username *string
	Role     *Role
	IsActive *bool
}

type EnrollTerminalInput struct {
	InstallationID string
	Name           string
	PublicKey      []byte
	DeviceModel    *string
	OSVersion      *string
	AppVersion     *string
}

type CreatePackageInput struct {
	Code         string
	Name         string
	Description  string
	UnitPrice    int64
	ChangeReason string
}

type UpdatePackageInput struct {
	Name         string
	Description  string
	UnitPrice    int64
	ChangeReason string
}

type ItemInput struct {
	PackageID       uuid.UUID `json:"packageId"`
	PackageRevision int       `json:"packageRevision"`
	Quantity        int       `json:"quantity"`
}

type MutationIdentity struct {
	TenantID             uuid.UUID
	OriginActorID        uuid.UUID
	OriginSessionID      uuid.UUID
	TerminalID           *uuid.UUID
	SubmittedByActorID   uuid.UUID
	SubmittedBySessionID uuid.UUID
	DataSpaceID          uuid.UUID
	DataMode             DataMode
}

func (identity MutationIdentity) EffectiveDataSpaceID() uuid.UUID {
	return EffectiveDataSpaceID(identity.DataSpaceID)
}

type CreateTransactionInput struct {
	ReceiptProfileRevision          *int          `json:"receiptProfileRevision,omitempty"`
	ID                              string        `json:"id"`
	OccurredAt                      time.Time     `json:"occurredAt"`
	PaymentMethod                   PaymentMethod `json:"paymentMethod"`
	QrisPayloadHash                 *string       `json:"qrisPayloadHash,omitempty"`
	Items                           []ItemInput   `json:"items"`
	InitialPaymentStatus            PaymentStatus `json:"-"`
	InitialPaymentConfirmedRevision *int          `json:"-"`
	Identity                        MutationIdentity
}

type CorrectTransactionInput struct {
	ID                         string        `json:"-"`
	BaseRevision               int           `json:"baseRevision"`
	Reason                     string        `json:"reason"`
	OccurredAt                 time.Time     `json:"occurredAt"`
	PaymentMethod              PaymentMethod `json:"paymentMethod"`
	QrisPayloadHash            *string       `json:"qrisPayloadHash,omitempty"`
	Items                      []ItemInput   `json:"items"`
	LegacyPaymentCompatibility bool          `json:"-"`
	Identity                   MutationIdentity
}

type SetPaymentStatusInput struct {
	ID           string        `json:"-"`
	BaseRevision int           `json:"baseRevision"`
	Status       PaymentStatus `json:"status"`
	OccurredAt   time.Time     `json:"occurredAt"`
	Identity     MutationIdentity
}

type PrintAttemptInput struct {
	ID                uuid.UUID       `json:"id"`
	TransactionID     string          `json:"transactionId,omitempty"`
	Revision          int             `json:"transactionRevision"`
	Status            string          `json:"status"`
	IsCopy            bool            `json:"isCopy"`
	PrinterKind       string          `json:"printerKind"`
	PrinterIdentifier *string         `json:"printerIdentifier,omitempty"`
	ErrorCode         *string         `json:"errorCode,omitempty"`
	ErrorMessage      *string         `json:"errorMessage,omitempty"`
	Metadata          json.RawMessage `json:"metadata,omitempty"`
	OccurredAt        time.Time       `json:"occurredAt"`
	Identity          MutationIdentity
}

type TransactionFilter struct {
	Search         string
	From           *time.Time
	To             *time.Time
	PackageID      *uuid.UUID
	CreatorID      *uuid.UUID
	TerminalID     *uuid.UUID
	PaymentMethod  *PaymentMethod
	PaymentStatus  *PaymentStatus
	IncludeDeleted bool
	Limit          int
	CursorOccurred *time.Time
	CursorID       string
	DataSpaceID    uuid.UUID
}

func EffectiveDataSpaceID(value uuid.UUID) uuid.UUID {
	return value
}

type TransactionPage struct {
	Transactions []Transaction `json:"items"`
	NextCursor   string        `json:"nextCursor,omitempty"`
}

type Cursor struct {
	OccurredAt time.Time `json:"occurredAt"`
	ID         string    `json:"id"`
}

func EncodeCursor(cursor Cursor) string {
	body, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(body)
}

func DecodeCursor(value string) (Cursor, error) {
	var cursor Cursor
	body, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return cursor, err
	}
	err = json.Unmarshal(body, &cursor)
	return cursor, err
}

func NormalizeUsername(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func NormalizePackageCode(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func ValidatePassword(value string) error {
	if len(value) < 12 || len(value) > 256 {
		return Validation("Kata sandi harus terdiri dari 12–256 karakter", map[string]any{"field": "password"})
	}
	return nil
}

func ValidateItems(items []ItemInput) error {
	if len(items) == 0 {
		return Validation("Transaksi harus memiliki setidaknya satu paket", map[string]any{"field": "items"})
	}
	if len(items) > 100 {
		return Validation("Transaksi memiliki terlalu banyak baris", map[string]any{"field": "items", "maximum": 100})
	}
	type packageRevisionKey struct {
		PackageID uuid.UUID
		Revision  int
	}
	seen := make(map[packageRevisionKey]struct{}, len(items))
	for index, item := range items {
		if item.PackageID == uuid.Nil || item.PackageRevision < 1 {
			return Validation("Referensi paket tidak valid", map[string]any{"field": "items", "index": index})
		}
		if item.Quantity < 1 || item.Quantity > 999 {
			return Validation("Jumlah paket harus antara 1 dan 999", map[string]any{"field": "items.quantity", "index": index})
		}
		key := packageRevisionKey{PackageID: item.PackageID, Revision: item.PackageRevision}
		if _, ok := seen[key]; ok {
			return Validation("Paket yang sama tidak boleh muncul dua kali", map[string]any{"field": "items", "index": index})
		}
		seen[key] = struct{}{}
	}
	return nil
}

func ValidateTransactionID(value string) error {
	if !ulidPattern.MatchString(value) {
		return Validation("ID transaksi harus berupa ULID 26 karakter", map[string]any{"field": "id"})
	}
	return nil
}

func ValidateSelectablePaymentMethod(value PaymentMethod) error {
	if !value.Selectable() {
		return Validation("Metode pembayaran harus cash atau qris", map[string]any{"field": "paymentMethod"})
	}
	return nil
}

// ValidateQrisPayloadBinding requires every newly written QRIS revision to be
// bound to the exact merchant payload used by the terminal. The digest is not
// normalized: accepting uppercase or surrounding whitespace would make the
// persisted identity ambiguous.
func ValidateQrisPayloadBinding(method PaymentMethod, hash *string) error {
	if method == PaymentMethodQRIS {
		if hash == nil || !qrisPayloadHashPattern.MatchString(*hash) {
			return Validation(
				"Hash payload QRIS wajib berupa 64 karakter heksadesimal huruf kecil",
				map[string]any{"field": "qrisPayloadHash"},
			)
		}
		return nil
	}
	if hash != nil {
		return Validation(
			"Hash payload QRIS hanya boleh digunakan untuk pembayaran QRIS",
			map[string]any{"field": "qrisPayloadHash"},
		)
	}
	return nil
}

func ValidatePaymentOutcome(value PaymentStatus) error {
	if value != PaymentStatusSuccess && value != PaymentStatusFailed {
		return Validation("Status pembayaran harus success atau failed", map[string]any{"field": "status"})
	}
	return nil
}

func CheckedLineTotal(price int64, quantity int) (int64, error) {
	if price <= 0 || quantity < 1 || quantity > 999 || price > math.MaxInt64/int64(quantity) {
		return 0, Validation("Nilai item transaksi tidak valid", nil)
	}
	return price * int64(quantity), nil
}

type SyncMutation struct {
	OperationID     string          `json:"operationId"`
	Aggregate       string          `json:"aggregate"`
	Action          string          `json:"action"`
	AggregateID     string          `json:"aggregateId"`
	BaseRevision    *int            `json:"baseRevision,omitempty"`
	OriginSessionID uuid.UUID       `json:"originSessionId"`
	OriginActorID   uuid.UUID       `json:"originActorId"`
	TerminalID      uuid.UUID       `json:"terminalId"`
	OccurredAt      time.Time       `json:"occurredAt"`
	Payload         json.RawMessage `json:"payload"`
	Signature       string          `json:"signature"`
}

type SyncOperationResult struct {
	OperationID string          `json:"operationId"`
	Status      int             `json:"status"`
	Data        json.RawMessage `json:"data,omitempty"`
	Error       *Error          `json:"error,omitempty"`
	Replayed    bool            `json:"replayed"`
}
