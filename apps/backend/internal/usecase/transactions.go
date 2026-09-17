package usecase

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/google/uuid"
)

type Transactions struct {
	Repo  port.Repository
	Clock port.Clock
}

func identity(principal domain.Principal) domain.MutationIdentity {
	return domain.MutationIdentity{
		OriginActorID:        principal.UserID,
		OriginSessionID:      principal.SessionID,
		TerminalID:           principal.TerminalID,
		SubmittedByActorID:   principal.UserID,
		SubmittedBySessionID: principal.SessionID,
		DataSpaceID:          principal.EffectiveDataSpaceID(),
		DataMode:             principal.EffectiveDataMode(),
		TenantID:             principal.TenantID,
	}
}

func (t Transactions) Create(ctx context.Context, principal domain.Principal, input domain.CreateTransactionInput) (domain.Transaction, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.Create")()
	if err := RequireTerminal(principal); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateTransactionID(input.ID); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateItems(input.Items); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateSelectablePaymentMethod(input.PaymentMethod); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateQrisPayloadBinding(input.PaymentMethod, input.QrisPayloadHash); err != nil {
		return domain.Transaction{}, err
	}
	if input.OccurredAt.IsZero() || input.OccurredAt.After(t.Clock.Now().Add(10*time.Minute)) {
		return domain.Transaction{}, domain.Validation("Waktu transaksi tidak valid", map[string]any{"field": "occurredAt"})
	}
	confirmedRevision := 1
	input.InitialPaymentStatus = domain.PaymentStatusSuccess
	input.InitialPaymentConfirmedRevision = &confirmedRevision
	input.Identity = identity(principal)
	return t.Repo.CreateTransaction(ctx, input)
}

func (t Transactions) Correct(ctx context.Context, principal domain.Principal, input domain.CorrectTransactionInput) (domain.Transaction, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.Correct")()
	if err := RequireTerminal(principal); err != nil {
		return domain.Transaction{}, err
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if err := domain.ValidateTransactionID(input.ID); err != nil {
		return domain.Transaction{}, err
	}
	current, err := t.Repo.GetTransaction(ctx, principal.EffectiveDataSpaceID(), input.ID, principal.IsSuperadmin())
	if err != nil {
		return domain.Transaction{}, err
	}
	if !domain.CanCorrectTransaction(principal.Role, principal.UserID, current.OriginActor.ID) {
		return domain.Transaction{}, domain.NewError(
			domain.CodeForbidden,
			"Admin hanya dapat mengoreksi transaksi miliknya sendiri",
		)
	}
	if input.BaseRevision < 1 || len(input.Reason) < 5 {
		return domain.Transaction{}, domain.Validation("Revisi dasar dan alasan koreksi wajib diisi", nil)
	}
	if err := domain.ValidateItems(input.Items); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateSelectablePaymentMethod(input.PaymentMethod); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateQrisPayloadBinding(input.PaymentMethod, input.QrisPayloadHash); err != nil {
		return domain.Transaction{}, err
	}
	if input.OccurredAt.IsZero() {
		return domain.Transaction{}, domain.Validation("Waktu transaksi tidak valid", map[string]any{"field": "occurredAt"})
	}
	input.Identity = identity(principal)
	return t.Repo.CorrectTransaction(ctx, input)
}

func (t Transactions) SetPaymentStatus(
	ctx context.Context,
	principal domain.Principal,
	input domain.SetPaymentStatusInput,
) (domain.Transaction, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.SetPaymentStatus")()
	if err := RequireTerminal(principal); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateTransactionID(input.ID); err != nil {
		return domain.Transaction{}, err
	}
	if input.BaseRevision < 1 {
		return domain.Transaction{}, domain.Validation(
			"Revisi transaksi wajib diisi",
			map[string]any{"field": "baseRevision"},
		)
	}
	if err := domain.ValidatePaymentOutcome(input.Status); err != nil {
		return domain.Transaction{}, err
	}
	if input.OccurredAt.IsZero() {
		return domain.Transaction{}, domain.Validation(
			"Waktu konfirmasi pembayaran tidak valid",
			map[string]any{"field": "occurredAt"},
		)
	}
	current, err := t.Repo.GetTransaction(ctx, principal.EffectiveDataSpaceID(), input.ID, principal.IsSuperadmin())
	if err != nil {
		return domain.Transaction{}, err
	}
	if !domain.CanCorrectTransaction(principal.Role, principal.UserID, current.OriginActor.ID) {
		return domain.Transaction{}, domain.NewError(
			domain.CodeForbidden,
			"Admin hanya dapat mengubah pembayaran transaksi miliknya sendiri",
		)
	}
	input.Identity = identity(principal)
	return t.Repo.SetTransactionPaymentStatus(ctx, input)
}

func (t Transactions) Get(ctx context.Context, principal domain.Principal, id string) (domain.Transaction, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.Get")()
	if err := RequireTenant(principal); err != nil {
		return domain.Transaction{}, err
	}
	if err := domain.ValidateTransactionID(id); err != nil {
		return domain.Transaction{}, err
	}
	return t.Repo.GetTransaction(ctx, principal.EffectiveDataSpaceID(), id, principal.IsSuperadmin())
}

func (t Transactions) List(ctx context.Context, principal domain.Principal, filter domain.TransactionFilter) (domain.TransactionPage, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.List")()
	if err := RequireTenant(principal); err != nil {
		return domain.TransactionPage{}, err
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		filter.Limit = 25
	}
	if !principal.IsSuperadmin() {
		filter.IncludeDeleted = false
	}
	filter.DataSpaceID = principal.EffectiveDataSpaceID()
	return t.Repo.ListTransactions(ctx, filter)
}

func (t Transactions) Revisions(ctx context.Context, principal domain.Principal, id string) ([]domain.TransactionRevision, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.Revisions")()
	if err := RequireTenant(principal); err != nil {
		return nil, err
	}
	if err := domain.ValidateTransactionID(id); err != nil {
		return nil, err
	}
	return t.Repo.ListTransactionRevisions(ctx, principal.EffectiveDataSpaceID(), id)
}

func (t Transactions) PrintAttempts(ctx context.Context, principal domain.Principal, id string) ([]domain.PrintAttempt, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.PrintAttempts")()
	if err := RequireTenant(principal); err != nil {
		return nil, err
	}
	if err := domain.ValidateTransactionID(id); err != nil {
		return nil, err
	}
	return t.Repo.ListPrintAttempts(ctx, principal.EffectiveDataSpaceID(), id)
}

func (t Transactions) Delete(ctx context.Context, principal domain.Principal, id, reason string) error {
	defer observability.StartSegment(ctx, "Usecase.Transactions.Delete")()
	if err := RequireSuperadmin(principal); err != nil {
		return err
	}
	if err := domain.ValidateTransactionID(id); err != nil {
		return err
	}
	reason = strings.TrimSpace(reason)
	if len(reason) < 3 {
		return domain.Validation("Alasan penghapusan transaksi wajib diisi", map[string]any{"field": "reason"})
	}
	return t.Repo.DeleteTransaction(ctx, principal, id, reason)
}

func (t Transactions) RecordPrint(ctx context.Context, principal domain.Principal, input domain.PrintAttemptInput) (domain.PrintAttempt, error) {
	defer observability.StartSegment(ctx, "Usecase.Transactions.RecordPrint")()
	if err := RequireTerminal(principal); err != nil {
		return domain.PrintAttempt{}, err
	}
	if input.ID == uuid.Nil {
		input.ID = uuid.New()
	}
	if err := domain.ValidateTransactionID(input.TransactionID); err != nil {
		return domain.PrintAttempt{}, err
	}
	if input.Revision < 1 || input.OccurredAt.IsZero() {
		return domain.PrintAttempt{}, domain.Validation("Revisi dan waktu cetak tidak valid", nil)
	}
	switch input.Status {
	case "pending", "success", "failed", "unknown":
	default:
		return domain.PrintAttempt{}, domain.Validation("Status cetak tidak valid", map[string]any{"field": "status"})
	}
	switch input.PrinterKind {
	case "simulator", "bluetooth", "integrated":
	default:
		return domain.PrintAttempt{}, domain.Validation("Jenis printer tidak valid", map[string]any{"field": "printerKind"})
	}
	if len(input.Metadata) == 0 {
		input.Metadata = json.RawMessage(`{}`)
	}
	input.Identity = identity(principal)
	return t.Repo.RecordPrintAttempt(ctx, input)
}
