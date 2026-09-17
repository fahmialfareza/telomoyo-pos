package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var (
	paymentMethodRolloutAt = time.Date(2026, time.July, 28, 17, 0, 0, 0, time.UTC)
	legacyPaymentCutoffAt  = time.Date(2026, time.August, 12, 17, 0, 0, 0, time.UTC)
)

// ApplySyncMutation performs the business mutation, audit/change writes, and
// idempotency result write in one PostgreSQL transaction. A transaction-scoped
// advisory lock serializes retries for the same terminal operation ID.
func (s *Store) ApplySyncMutation(
	ctx context.Context,
	submitter domain.Principal,
	operation domain.SyncMutation,
	requestHash []byte,
) (domain.StoredOperationResult, bool, error) {
	defer observability.StartSegment(ctx, "Postgres.ApplySyncMutation")()
	// READ COMMITTED is required by the Sandbox generation lock. PostgreSQL
	// fixes a SERIALIZABLE snapshot before a waiting advisory-lock statement is
	// evaluated; after reset wins the exclusive lock, that stale snapshot could
	// still see the retired generation as active. The generation lock and the
	// per-operation advisory lock provide the serialization needed here, while
	// row-level locks protect transaction revisions and payment state.
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return domain.StoredOperationResult{}, false, dbError(err, "begin sync operation")
	}
	defer tx.Rollback(ctx)
	dataSpaceID := submitter.EffectiveDataSpaceID()
	if submitter.ContextKind != domain.ContextTenant || submitter.MembershipID == uuid.Nil {
		return domain.StoredOperationResult{}, false, domain.NewError(domain.CodeContextRequired, "Pilih usaha untuk sinkronisasi")
	}
	identity := domain.MutationIdentity{
		OriginActorID:        operation.OriginActorID,
		OriginSessionID:      operation.OriginSessionID,
		TerminalID:           &operation.TerminalID,
		SubmittedByActorID:   submitter.UserID,
		SubmittedBySessionID: submitter.SessionID,
		DataSpaceID:          dataSpaceID,
		DataMode:             submitter.EffectiveDataMode(),
		TenantID:             submitter.TenantID,
	}
	if _, err := lockMutationIdentity(ctx, tx, identity); err != nil {
		return domain.StoredOperationResult{}, false, err
	}
	space, err := lockActiveDataSpace(ctx, tx, dataSpaceID)
	if err != nil {
		return domain.StoredOperationResult{}, false, err
	}
	lockKey := dataSpaceID.String() + ":" + operation.TerminalID.String() + ":" + operation.OperationID
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey); err != nil {
		return domain.StoredOperationResult{}, false, dbError(err, "lock sync operation")
	}

	var stored domain.StoredOperationResult
	err = tx.QueryRow(ctx, `
		SELECT request_hash, response_status, response
		FROM idempotency_records
		WHERE data_space_id = $1 AND terminal_id = $2 AND operation_id = $3`,
		dataSpaceID, operation.TerminalID, operation.OperationID,
	).Scan(&stored.RequestHash, &stored.Status, &stored.Response)
	if err == nil {
		if !bytes.Equal(stored.RequestHash, requestHash) {
			return domain.StoredOperationResult{}, false,
				domain.NewError(domain.CodeIdempotencyMismatch, "operationId telah digunakan untuk payload yang berbeda")
		}
		if err = tx.Commit(ctx); err != nil {
			return domain.StoredOperationResult{}, false, dbError(err, "commit replayed sync operation")
		}
		if stored.Status >= 400 {
			var operationError domain.Error
			if json.Unmarshal(stored.Response, &operationError) == nil {
				return stored, true, &operationError
			}
		}
		return stored, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.StoredOperationResult{}, false, dbError(err, "read sync idempotency")
	}
	if _, err = tx.Exec(ctx, `SAVEPOINT sync_business_mutation`); err != nil {
		return domain.StoredOperationResult{}, false, dbError(err, "savepoint sync mutation")
	}

	identity.DataMode = space.Mode
	var data any
	status := http.StatusOK
	operationErr := error(nil)

	switch operation.Aggregate + "/" + operation.Action {
	case "transaction/create":
		var payload struct {
			ID                     string                    `json:"id"`
			PaymentMethod          syncOptionalPaymentMethod `json:"paymentMethod"`
			QrisPayloadHash        *string                   `json:"qrisPayloadHash"`
			ReceiptProfileRevision *int                      `json:"receiptProfileRevision"`
			Items                  []domain.ItemInput        `json:"items"`
		}
		if err := json.Unmarshal(operation.Payload, &payload); err != nil || operation.OccurredAt.IsZero() {
			operationErr = domain.Validation("Payload transaksi tidak valid", nil)
			break
		}
		if operation.AggregateID != "" && operation.AggregateID != payload.ID {
			operationErr = domain.Validation("aggregateId tidak cocok dengan transaksi", nil)
			break
		}
		if err := domain.ValidateTransactionID(payload.ID); err != nil {
			operationErr = err
			break
		}
		if err := domain.ValidateItems(payload.Items); err != nil {
			operationErr = err
			break
		}
		if !payload.PaymentMethod.Present {
			if compatibilityErr := s.requireLegacyPaymentCompatibility(
				ctx, tx, operation,
			); compatibilityErr != nil {
				operationErr = compatibilityErr
				break
			}
		}
		paymentMethod, paymentStatus, paymentConfirmedRevision, paymentErr :=
			syncedCreatePayment(payload.PaymentMethod)
		if paymentErr != nil {
			operationErr = paymentErr
			break
		}
		if !payload.PaymentMethod.Present {
			s.logLegacyPaymentCompatibility(ctx, operation)
		}
		data, operationErr = s.createTransactionTx(ctx, tx, domain.CreateTransactionInput{
			ID: payload.ID, OccurredAt: operation.OccurredAt,
			PaymentMethod: paymentMethod, QrisPayloadHash: payload.QrisPayloadHash,
			ReceiptProfileRevision:          payload.ReceiptProfileRevision,
			Items:                           payload.Items,
			InitialPaymentStatus:            paymentStatus,
			InitialPaymentConfirmedRevision: paymentConfirmedRevision,
			Identity:                        identity,
		})
		status = http.StatusCreated
	case "transaction/correct":
		var payload struct {
			BaseRevision    int                       `json:"baseRevision"`
			Reason          string                    `json:"reason"`
			PaymentMethod   syncOptionalPaymentMethod `json:"paymentMethod"`
			QrisPayloadHash *string                   `json:"qrisPayloadHash"`
			Items           []domain.ItemInput        `json:"items"`
		}
		if err := json.Unmarshal(operation.Payload, &payload); err != nil ||
			operation.AggregateID == "" ||
			operation.OccurredAt.IsZero() {
			operationErr = domain.Validation("Payload koreksi tidak valid", nil)
			break
		}
		baseRevision := payload.BaseRevision
		if operation.BaseRevision != nil {
			baseRevision = *operation.BaseRevision
		}
		if baseRevision < 1 || len(strings.TrimSpace(payload.Reason)) < 5 {
			operationErr = domain.Validation("Revisi dasar dan alasan koreksi wajib diisi", nil)
			break
		}
		if err := domain.ValidateItems(payload.Items); err != nil {
			operationErr = err
			break
		}
		if !payload.PaymentMethod.Present {
			if compatibilityErr := s.requireLegacyPaymentCompatibility(
				ctx, tx, operation,
			); compatibilityErr != nil {
				operationErr = compatibilityErr
				break
			}
		}
		paymentMethod, legacyPaymentCompatibility, paymentErr :=
			syncedCorrectionPayment(payload.PaymentMethod)
		if paymentErr != nil {
			operationErr = paymentErr
			break
		}
		if !payload.PaymentMethod.Present {
			s.logLegacyPaymentCompatibility(ctx, operation)
		}
		data, operationErr = s.correctTransactionTx(ctx, tx, domain.CorrectTransactionInput{
			ID: operation.AggregateID, BaseRevision: baseRevision, Reason: strings.TrimSpace(payload.Reason),
			OccurredAt: operation.OccurredAt, PaymentMethod: paymentMethod,
			QrisPayloadHash: payload.QrisPayloadHash, Items: payload.Items,
			LegacyPaymentCompatibility: legacyPaymentCompatibility,
			Identity:                   identity,
		})
	case "transaction/set_payment_status":
		var payload struct {
			ID     string               `json:"id"`
			Status domain.PaymentStatus `json:"status"`
		}
		if err := json.Unmarshal(operation.Payload, &payload); err != nil ||
			operation.AggregateID == "" ||
			operation.BaseRevision == nil ||
			operation.OccurredAt.IsZero() {
			operationErr = domain.Validation("Payload status pembayaran tidak valid", nil)
			break
		}
		if payload.ID != operation.AggregateID {
			operationErr = domain.Validation("aggregateId tidak cocok dengan transaksi", nil)
			break
		}
		if err := domain.ValidateTransactionID(payload.ID); err != nil {
			operationErr = err
			break
		}
		if err := domain.ValidatePaymentOutcome(payload.Status); err != nil {
			operationErr = err
			break
		}
		data, operationErr = s.setTransactionPaymentStatusTx(ctx, tx, domain.SetPaymentStatusInput{
			ID: payload.ID, BaseRevision: *operation.BaseRevision,
			Status: payload.Status, OccurredAt: operation.OccurredAt,
			Identity: identity,
		})
	case "print_attempt/create":
		var payload domain.PrintAttemptInput
		if err := json.Unmarshal(operation.Payload, &payload); err != nil || payload.TransactionID == "" {
			operationErr = domain.Validation("Payload upaya cetak tidak valid", nil)
			break
		}
		payload.Identity = identity
		payload.OccurredAt = operation.OccurredAt
		if payload.ID == uuid.Nil || operation.AggregateID != payload.ID.String() || payload.Revision < 1 || payload.OccurredAt.IsZero() {
			operationErr = domain.Validation("ID, revisi, dan waktu cetak tidak valid", nil)
			break
		}
		data, operationErr = s.recordPrintAttemptTx(ctx, tx, payload)
		status = http.StatusCreated
	default:
		operationErr = domain.Validation("Jenis operasi sinkronisasi tidak didukung", nil)
	}

	if operationErr != nil {
		if _, rollbackErr := tx.Exec(ctx, `ROLLBACK TO SAVEPOINT sync_business_mutation`); rollbackErr != nil {
			return domain.StoredOperationResult{}, false, dbError(rollbackErr, "rollback rejected sync mutation")
		}
		domainErr := domain.AsError(operationErr)
		status = operationErrorStatus(domainErr)
		if status >= 500 {
			return domain.StoredOperationResult{}, false, operationErr
		}
		stored = domain.StoredOperationResult{RequestHash: requestHash, Status: status}
		stored.Response, err = json.Marshal(domainErr)
		if err != nil {
			return domain.StoredOperationResult{}, false, domain.WrapInternal(err, "marshal sync error result")
		}
	} else {
		stored = domain.StoredOperationResult{RequestHash: requestHash, Status: status}
		stored.Response, err = json.Marshal(data)
		if err != nil {
			return domain.StoredOperationResult{}, false, domain.WrapInternal(err, "marshal sync success result")
		}
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO idempotency_records (
			data_space_id, terminal_id, operation_id, request_hash, response_status, response
		) VALUES ($1,$2,$3,$4,$5,$6)`,
		dataSpaceID, operation.TerminalID, operation.OperationID, requestHash, stored.Status, stored.Response,
	); err != nil {
		return domain.StoredOperationResult{}, false, dbError(err, "persist atomic sync result")
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.StoredOperationResult{}, false, dbError(err, "commit atomic sync result")
	}
	return stored, false, operationErr
}

// TODO(payment-method-rollout): Remove this compatibility decoder after the
// warning telemetry confirms that all pre-payment queued operations have drained.
//
// syncOptionalPaymentMethod deliberately distinguishes an absent JSON member
// from an explicit null. Only absence is accepted for append-only operations
// signed by clients released before paymentMethod became part of the contract.
// Explicit null is always invalid, just like any other non-selectable value.
type syncOptionalPaymentMethod struct {
	Value   domain.PaymentMethod
	Present bool
	Null    bool
}

func (value *syncOptionalPaymentMethod) UnmarshalJSON(data []byte) error {
	value.Present = true
	value.Null = false
	value.Value = ""
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		value.Null = true
		return nil
	}
	return json.Unmarshal(data, &value.Value)
}

func syncedCreatePayment(
	value syncOptionalPaymentMethod,
) (domain.PaymentMethod, domain.PaymentStatus, *int, error) {
	if !value.Present {
		confirmedRevision := 1
		return domain.PaymentMethodLegacy, domain.PaymentStatusSuccess, &confirmedRevision, nil
	}
	if value.Null {
		return "", "", nil, domain.Validation(
			"Metode pembayaran wajib dipilih",
			map[string]any{"field": "paymentMethod"},
		)
	}
	if err := domain.ValidateSelectablePaymentMethod(value.Value); err != nil {
		return "", "", nil, err
	}
	// Transactions are payment-confirmed at creation; the confirmation step no
	// longer exists.
	confirmedRevision := 1
	return value.Value, domain.PaymentStatusSuccess, &confirmedRevision, nil
}

func syncedCorrectionPayment(
	value syncOptionalPaymentMethod,
) (domain.PaymentMethod, bool, error) {
	if !value.Present {
		return domain.PaymentMethodLegacy, true, nil
	}
	if value.Null {
		return "", false, domain.Validation(
			"Metode pembayaran wajib dipilih",
			map[string]any{"field": "paymentMethod"},
		)
	}
	if err := domain.ValidateSelectablePaymentMethod(value.Value); err != nil {
		return "", false, err
	}
	return value.Value, false, nil
}

func (s *Store) requireLegacyPaymentCompatibility(
	ctx context.Context,
	tx pgx.Tx,
	operation domain.SyncMutation,
) error {
	defer observability.StartSegment(ctx, "Postgres.requireLegacyPaymentCompatibility")()

	var terminalCreatedAt time.Time
	var migratedOrigin bool
	if err := tx.QueryRow(ctx, `
		SELECT t.created_at, s.legacy_origin AND s.tenant_id = $4
		FROM terminals t JOIN sessions s ON s.terminal_id = t.id AND s.tenant_id = t.tenant_id
		WHERE t.id = $1 AND t.is_active AND t.revoked_at IS NULL
		  AND s.id = $2 AND s.user_id = $3`,
		operation.TerminalID, operation.OriginSessionID, operation.OriginActorID, domain.InitialTenantID(),
	).Scan(&terminalCreatedAt, &migratedOrigin); err != nil {
		return dbError(err, "verify legacy payment compatibility")
	}
	if migratedOrigin && terminalCreatedAt.Before(paymentMethodRolloutAt) && operation.OccurredAt.Before(paymentMethodRolloutAt) {
		return nil
	}
	return domain.Validation(
		"Versi aplikasi ini wajib mengirim metode pembayaran. Perbarui aplikasi lalu coba lagi",
		map[string]any{"field": "paymentMethod"},
	)
}

func legacyPaymentOperationEligible(
	operationOccurredAt time.Time,
	terminalCreatedAt time.Time,
	serverNow time.Time,
) bool {
	return terminalCreatedAt.Before(paymentMethodRolloutAt) &&
		operationOccurredAt.Before(paymentMethodRolloutAt) &&
		serverNow.Before(legacyPaymentCutoffAt)
}

func (s *Store) logLegacyPaymentCompatibility(
	ctx context.Context,
	operation domain.SyncMutation,
) {
	defer observability.StartSegment(ctx, "Postgres.logLegacyPaymentCompatibility")()
	logger := s.Logger
	if logger == nil {
		logger = observability.Logger()
	}
	logger.
		WithContext(ctx).
		WithFields(map[string]any{
			"aggregate":   operation.Aggregate,
			"action":      operation.Action,
			"aggregateId": operation.AggregateID,
			"operationId": operation.OperationID,
			"terminalId":  operation.TerminalID,
		}).
		Warn("accepted legacy sync payload without paymentMethod")
}

func operationErrorStatus(err *domain.Error) int {
	switch err.Code {
	case domain.CodeValidation:
		return http.StatusUnprocessableEntity
	case domain.CodeUnauthorized:
		return http.StatusUnauthorized
	case domain.CodeForbidden, domain.CodePasswordChange, domain.CodeSignatureInvalid,
		domain.CodeTenantSuspended, domain.CodeMembershipInactive, domain.CodeMembershipRevoked, domain.CodeContextRequired:
		return http.StatusForbidden
	case domain.CodeNotFound:
		return http.StatusNotFound
	case domain.CodeRevisionConflict, domain.CodePaymentStateConflict,
		domain.CodeConflict, domain.CodeIdempotencyMismatch, domain.CodeSandboxGenerationRetired:
		return http.StatusConflict
	case domain.CodeRateLimited:
		return http.StatusTooManyRequests
	default:
		return http.StatusInternalServerError
	}
}
