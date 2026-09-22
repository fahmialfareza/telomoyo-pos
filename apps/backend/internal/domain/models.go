package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type Role string

const (
	RoleAdmin      Role = "admin"
	RoleSuperadmin Role = "superadmin"
)

func (r Role) Valid() bool { return r == RoleAdmin || r == RoleSuperadmin }

// DataMode identifies the independently synchronized business data plane used
// by a session. Authentication identities and terminals remain global.
type DataMode string

const (
	DataModeProduction DataMode = "production"
	DataModeSandbox    DataMode = "sandbox"

	LiveDataSpaceIDString = "00000000-0000-4000-8000-000000000100"
)

func (mode DataMode) Valid() bool {
	return mode == DataModeProduction || mode == DataModeSandbox
}

type DataSpaceStatus string

const (
	DataSpaceStatusActive  DataSpaceStatus = "active"
	DataSpaceStatusRetired DataSpaceStatus = "retired"
	DataSpaceStatusPurged  DataSpaceStatus = "purged"
)

type DataSpace struct {
	ID          uuid.UUID       `json:"id"`
	TenantID    uuid.UUID       `json:"tenantId"`
	Mode        DataMode        `json:"mode"`
	Generation  int64           `json:"generation"`
	Status      DataSpaceStatus `json:"status"`
	ActivatedAt time.Time       `json:"activatedAt"`
	RetiredAt   *time.Time      `json:"retiredAt"`
	PurgeAfter  *time.Time      `json:"purgeAfter"`
	PurgedAt    *time.Time      `json:"purgedAt"`
}

func LiveDataSpaceID() uuid.UUID { return uuid.MustParse(LiveDataSpaceIDString) }

type PaymentMethod string

const (
	PaymentMethodCash   PaymentMethod = "cash"
	PaymentMethodQRIS   PaymentMethod = "qris"
	PaymentMethodLegacy PaymentMethod = "legacy"
)

func (method PaymentMethod) Valid() bool {
	return method == PaymentMethodCash ||
		method == PaymentMethodQRIS ||
		method == PaymentMethodLegacy
}

// Selectable reports whether a payment method may be chosen for a new or
// corrected transaction. Legacy is read-only rollout compatibility.
func (method PaymentMethod) Selectable() bool {
	return method == PaymentMethodCash || method == PaymentMethodQRIS
}

type PaymentStatus string

const (
	PaymentStatusPending PaymentStatus = "pending"
	PaymentStatusSuccess PaymentStatus = "success"
	PaymentStatusFailed  PaymentStatus = "failed"
)

func (status PaymentStatus) Valid() bool {
	return status == PaymentStatusPending ||
		status == PaymentStatusSuccess ||
		status == PaymentStatusFailed
}

type Principal struct {
	ContextKind        ContextKind       `json:"contextKind"`
	TenantID           uuid.UUID         `json:"tenantId,omitempty"`
	MembershipID       uuid.UUID         `json:"membershipId,omitempty"`
	Tenant             *Tenant           `json:"tenant,omitempty"`
	IsPlatformAdmin    bool              `json:"isPlatformAdmin"`
	LegacyOrigin       bool              `json:"-"`
	UserCreatedAt      time.Time         `json:"-"`
	UserUpdatedAt      time.Time         `json:"-"`
	Terminal           *Terminal         `json:"-"`
	UserID             uuid.UUID         `json:"userId"`
	SessionID          uuid.UUID         `json:"sessionId"`
	TerminalID         *uuid.UUID        `json:"terminalId,omitempty"`
	FullName           string            `json:"fullName"`
	Username           string            `json:"username"`
	Role               Role              `json:"role"`
	MustChangePassword bool              `json:"mustChangePassword"`
	DataSpaceID        uuid.UUID         `json:"dataSpaceId"`
	DataMode           DataMode          `json:"dataMode"`
	SandboxGeneration  int64             `json:"sandboxGeneration"`
	ProtocolVersion    int               `json:"protocolVersion"`
	SandboxQRISPolicy  SandboxQRISPolicy `json:"sandboxQrisPolicy"`
	// SandboxEnabledOverride is internal authorization state. Nil inherits the
	// deployment default and is never serialized in session responses.
	SandboxEnabledOverride *bool `json:"-"`
}

func (p Principal) IsSuperadmin() bool { return p.Role == RoleSuperadmin }

func (p Principal) EffectiveTenantID() uuid.UUID { return p.TenantID }

func (p Principal) EffectiveContextKind() ContextKind { return p.ContextKind }

func (p Principal) IsTenantContext() bool {
	return p.ContextKind == ContextTenant && p.TenantID != uuid.Nil && p.DataSpaceID != uuid.Nil
}

func (p Principal) EffectiveDataSpaceID() uuid.UUID {
	return EffectiveDataSpaceID(p.DataSpaceID)
}

func (p Principal) EffectiveDataMode() DataMode {
	if !p.DataMode.Valid() {
		return DataModeProduction
	}
	return p.DataMode
}

func CanCorrectTransaction(role Role, actorID, ownerID uuid.UUID) bool {
	return role == RoleSuperadmin || actorID == ownerID
}

type User struct {
	ID                 uuid.UUID  `json:"id"`
	FullName           string     `json:"fullName"`
	Username           string     `json:"username"`
	Role               Role       `json:"role"`
	IsActive           bool       `json:"active"`
	MustChangePassword bool       `json:"mustChangePassword"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
	DeletedAt          *time.Time `json:"deletedAt"`
}

type UserAuth struct {
	User
	PasswordHash string
}

type Package struct {
	ID              uuid.UUID  `json:"id"`
	Code            string     `json:"code"`
	CurrentRevision int        `json:"revision"`
	Name            string     `json:"name"`
	Description     string     `json:"description"`
	UnitPrice       int64      `json:"unitPrice"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	DeletedAt       *time.Time `json:"deletedAt,omitempty"`
	DataSpaceID     uuid.UUID  `json:"dataSpaceId"`
	SourcePackageID *uuid.UUID `json:"sourcePackageId,omitempty"`
	SourceRevision  *int       `json:"sourceRevision,omitempty"`
}

type PackageSnapshot struct {
	ID          uuid.UUID `json:"id"`
	Revision    int       `json:"revision"`
	Code        string    `json:"code"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	UnitPrice   int64     `json:"unitPrice"`
}

type TransactionItem struct {
	LineNumber         int       `json:"lineNumber"`
	PackageID          uuid.UUID `json:"packageId"`
	PackageRevision    int       `json:"packageRevision"`
	PackageCode        string    `json:"packageCode"`
	PackageName        string    `json:"packageName"`
	PackageDescription string    `json:"packageDescription"`
	UnitPrice          int64     `json:"unitPrice"`
	Quantity           int       `json:"quantity"`
	LineTotal          int64     `json:"lineTotal"`
}

type ActorSummary struct {
	ID       uuid.UUID `json:"id"`
	FullName string    `json:"fullName"`
	Username string    `json:"username"`
	Role     Role      `json:"role"`
}

type Transaction struct {
	ReceiptProfileRevision   *int              `json:"receiptProfileRevision,omitempty"`
	ReceiptIdentity          *ReceiptIdentity  `json:"receiptIdentity,omitempty"`
	ID                       string            `json:"id"`
	DisplayID                string            `json:"displayId"`
	Revision                 int               `json:"revision"`
	OccurredAt               time.Time         `json:"occurredAt"`
	ServerReceivedAt         time.Time         `json:"serverReceivedAt"`
	Subtotal                 int64             `json:"subtotal"`
	Total                    int64             `json:"total"`
	PaymentAmount            int64             `json:"paymentAmount"`
	PaymentMethod            PaymentMethod     `json:"paymentMethod"`
	QrisPayloadHash          *string           `json:"qrisPayloadHash,omitempty"`
	PaymentStatus            PaymentStatus     `json:"paymentStatus"`
	PaymentConfirmedRevision *int              `json:"paymentConfirmedRevision,omitempty"`
	PrintState               string            `json:"printState"`
	LatestPrintedRevision    *int              `json:"latestPrintedRevision,omitempty"`
	OriginActor              ActorSummary      `json:"originActor"`
	UpdatedBy                ActorSummary      `json:"updatedBy"`
	TerminalID               *uuid.UUID        `json:"terminalId,omitempty"`
	Items                    []TransactionItem `json:"items"`
	DeletedAt                *time.Time        `json:"deletedAt,omitempty"`
	DeletedBy                *ActorSummary     `json:"deletedBy,omitempty"`
	DeleteReason             *string           `json:"deleteReason,omitempty"`
	UpdatedAt                time.Time         `json:"updatedAt"`
	DataSpaceID              uuid.UUID         `json:"dataSpaceId"`
}

type TransactionRevision struct {
	ReceiptIdentity  *ReceiptIdentity  `json:"receiptIdentity,omitempty"`
	TransactionID    string            `json:"transactionId"`
	Revision         int               `json:"revision"`
	BaseRevision     *int              `json:"baseRevision,omitempty"`
	ChangeType       string            `json:"changeType"`
	Reason           *string           `json:"reason,omitempty"`
	QrisPayloadHash  *string           `json:"qrisPayloadHash,omitempty"`
	BeforeSnapshot   json.RawMessage   `json:"beforeSnapshot,omitempty"`
	AfterSnapshot    json.RawMessage   `json:"afterSnapshot"`
	OriginActorID    uuid.UUID         `json:"originActorId"`
	SubmittedBy      uuid.UUID         `json:"submittedBy"`
	TerminalID       *uuid.UUID        `json:"terminalId,omitempty"`
	ClientOccurredAt time.Time         `json:"clientOccurredAt"`
	ServerReceivedAt time.Time         `json:"serverReceivedAt"`
	Items            []TransactionItem `json:"items"`
	PaymentAmount    int64             `json:"paymentAmount"`
	DataSpaceID      uuid.UUID         `json:"dataSpaceId"`
}

type PrintAttempt struct {
	ID                  uuid.UUID       `json:"id"`
	TransactionID       string          `json:"transactionId"`
	TransactionRevision int             `json:"transactionRevision"`
	TerminalID          *uuid.UUID      `json:"terminalId,omitempty"`
	ActorID             uuid.UUID       `json:"actorId"`
	Status              string          `json:"status"`
	IsCopy              bool            `json:"isCopy"`
	PrinterKind         string          `json:"printerKind"`
	PrinterIdentifier   *string         `json:"printerIdentifier,omitempty"`
	ErrorCode           *string         `json:"errorCode,omitempty"`
	ErrorMessage        *string         `json:"errorMessage,omitempty"`
	Metadata            json.RawMessage `json:"metadata"`
	ClientOccurredAt    time.Time       `json:"clientOccurredAt"`
	ServerReceivedAt    time.Time       `json:"serverReceivedAt"`
	DataSpaceID         uuid.UUID       `json:"dataSpaceId"`
}

type Dashboard struct {
	From               time.Time         `json:"from"`
	To                 time.Time         `json:"to"`
	GrossRevenue       int64             `json:"grossRevenue"`
	ActualQrisAmount   int64             `json:"actualQrisAmount"`
	TransactionCount   int64             `json:"transactionCount"`
	PackageQuantities  []PackageQuantity `json:"packageQuantities"`
	Trend              []TrendBucket     `json:"trend"`
	RecentTransactions []Transaction     `json:"recentTransactions"`
}

type PackageQuantity struct {
	PackageID   uuid.UUID `json:"packageId"`
	PackageName string    `json:"packageName"`
	Quantity    int64     `json:"quantity"`
}

type TrendBucket struct {
	Bucket time.Time `json:"bucket"`
	Total  int64     `json:"total"`
	Count  int64     `json:"count"`
}

type Terminal struct {
	ID             uuid.UUID  `json:"id"`
	InstallationID string     `json:"installationId"`
	Name           string     `json:"name"`
	PublicKey      []byte     `json:"publicKey"`
	Algorithm      string     `json:"algorithm"`
	Platform       string     `json:"platform"`
	DeviceModel    *string    `json:"deviceModel,omitempty"`
	OSVersion      *string    `json:"osVersion,omitempty"`
	AppVersion     *string    `json:"appVersion,omitempty"`
	IsActive       bool       `json:"active"`
	CreatedAt      time.Time  `json:"enrolledAt"`
	RevokedAt      *time.Time `json:"revokedAt"`
}

type SyncChange struct {
	Cursor      int64           `json:"cursor"`
	Aggregate   string          `json:"aggregate"`
	AggregateID string          `json:"aggregateId"`
	Action      string          `json:"action"`
	Revision    *int            `json:"revision,omitempty"`
	Payload     json.RawMessage `json:"payload"`
	Tombstone   bool            `json:"tombstone"`
	CreatedAt   time.Time       `json:"createdAt"`
	DataSpaceID uuid.UUID       `json:"dataSpaceId"`
}

type StoredOperationResult struct {
	RequestHash []byte          `json:"-"`
	Status      int             `json:"status"`
	Response    json.RawMessage `json:"response"`
}

type ExportRow struct {
	TransactionID    string
	OccurredAt       time.Time
	Revision         int
	PackageCode      string
	PackageName      string
	PackageRevision  int
	UnitPrice        int64
	Quantity         int
	LineTotal        int64
	TransactionTotal int64
	PaymentAmount    int64
	CreatorName      string
	CreatorUsername  string
	PaymentMethod    PaymentMethod
	QrisPayloadHash  *string
	PaymentStatus    PaymentStatus
	PrintState       string
}

type SandboxResetResult struct {
	Previous            DataSpace `json:"previous"`
	Current             DataSpace `json:"current"`
	ClonedPackageCount  int       `json:"clonedPackageCount"`
	RevokedSessionCount int64     `json:"revokedSessionCount"`
}

type SandboxCleanupResult struct {
	PurgedGenerationCount int   `json:"purgedGenerationCount"`
	PurgedRowCount        int64 `json:"purgedRowCount"`
}

type SandboxStatus struct {
	Enabled           bool              `json:"enabled"`
	DataMode          DataMode          `json:"dataMode"`
	DataSpaceID       *uuid.UUID        `json:"dataSpaceId"`
	Generation        *int64            `json:"generation"`
	RetentionDays     int               `json:"retentionDays"`
	QrisAmount        *int64            `json:"qrisAmount"`
	SandboxQRISPolicy SandboxQRISPolicy `json:"sandboxQrisPolicy"`
}
