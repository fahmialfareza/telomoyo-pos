package postgres

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
)

func TestLegacyPaymentOperationEligibilityIsBounded(t *testing.T) {
	t.Parallel()

	oldTerminal := paymentMethodRolloutAt.Add(-24 * time.Hour)
	oldOperation := paymentMethodRolloutAt.Add(-time.Minute)
	beforeCutoff := legacyPaymentCutoffAt.Add(-time.Second)
	if !legacyPaymentOperationEligible(oldOperation, oldTerminal, beforeCutoff) {
		t.Fatal("eligible pre-rollout operation was rejected before the server cutoff")
	}

	tests := []struct {
		name       string
		occurredAt time.Time
		enrolledAt time.Time
		serverNow  time.Time
	}{
		{
			name: "new operation", occurredAt: paymentMethodRolloutAt,
			enrolledAt: oldTerminal, serverNow: beforeCutoff,
		},
		{
			name: "new terminal", occurredAt: oldOperation,
			enrolledAt: paymentMethodRolloutAt, serverNow: beforeCutoff,
		},
		{
			name: "server cutoff reached", occurredAt: oldOperation,
			enrolledAt: oldTerminal, serverNow: legacyPaymentCutoffAt,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if legacyPaymentOperationEligible(
				test.occurredAt,
				test.enrolledAt,
				test.serverNow,
			) {
				t.Fatal("ineligible legacy payment operation was accepted")
			}
		})
	}
}

func TestResolvePaymentTransition(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		current       domain.PaymentStatus
		target        domain.PaymentStatus
		wantChanged   bool
		wantConfirmed bool
		wantConflict  bool
	}{
		{
			name: "pending to success", current: domain.PaymentStatusPending,
			target: domain.PaymentStatusSuccess, wantChanged: true, wantConfirmed: true,
		},
		{
			name: "pending to failed", current: domain.PaymentStatusPending,
			target: domain.PaymentStatusFailed, wantChanged: true,
		},
		{
			name: "failed to success", current: domain.PaymentStatusFailed,
			target: domain.PaymentStatusSuccess, wantChanged: true, wantConfirmed: true,
		},
		{
			name: "failed retry", current: domain.PaymentStatusFailed,
			target: domain.PaymentStatusFailed,
		},
		{
			name: "success retry", current: domain.PaymentStatusSuccess,
			target: domain.PaymentStatusSuccess,
		},
		{
			name: "success cannot fail", current: domain.PaymentStatusSuccess,
			target: domain.PaymentStatusFailed, wantConflict: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			confirmed, changed, err := resolvePaymentTransition(test.current, test.target, 7)
			if domain.IsCode(err, domain.CodePaymentStateConflict) != test.wantConflict {
				t.Fatalf(
					"payment conflict=%v, want %v (err=%v)",
					domain.IsCode(err, domain.CodePaymentStateConflict),
					test.wantConflict,
					err,
				)
			}
			if test.wantConflict {
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if changed != test.wantChanged {
				t.Fatalf("changed=%v, want %v", changed, test.wantChanged)
			}
			if (confirmed != nil) != test.wantConfirmed {
				t.Fatalf("confirmed=%v, want pointer=%v", confirmed, test.wantConfirmed)
			}
			if confirmed != nil && *confirmed != 7 {
				t.Fatalf("confirmed revision=%d, want 7", *confirmed)
			}
		})
	}
}

func TestPaymentFinalConflictIncludesAuthoritativeSnapshot(t *testing.T) {
	t.Parallel()

	confirmedRevision := 7
	_, _, transitionErr := resolvePaymentTransition(
		domain.PaymentStatusSuccess,
		domain.PaymentStatusFailed,
		confirmedRevision,
	)
	err := attachPaymentConflictServerSnapshot(
		transitionErr,
		json.RawMessage(`{
			"occurredAt":"2026-07-29T00:00:00Z",
			"subtotal":70000,
			"total":70000,
			"items":[]
		}`),
		confirmedRevision,
		domain.PaymentMethodQRIS,
		1_000,
		nil,
		domain.PaymentStatusSuccess,
		&confirmedRevision,
	)
	domainErr := domain.AsError(err)
	snapshot, ok := domainErr.Details["serverSnapshot"].(map[string]any)
	if !ok {
		t.Fatalf("server snapshot missing from payment conflict: %#v", domainErr.Details)
	}
	if snapshot["paymentMethod"] != domain.PaymentMethodQRIS ||
		snapshot["paymentStatus"] != domain.PaymentStatusSuccess {
		t.Fatalf("authoritative payment state is wrong: %#v", snapshot)
	}
	if got, ok := snapshot["paymentConfirmedRevision"].(*int); !ok ||
		got == nil ||
		*got != confirmedRevision {
		t.Fatalf("confirmed revision is wrong: %#v", snapshot)
	}
}

func TestSyncedPaymentCompatibility(t *testing.T) {
	t.Parallel()

	method, status, confirmed, err := syncedCreatePayment(syncOptionalPaymentMethod{})
	if err != nil {
		t.Fatal(err)
	}
	if method != domain.PaymentMethodLegacy ||
		status != domain.PaymentStatusSuccess ||
		confirmed == nil ||
		*confirmed != 1 {
		t.Fatalf("old create compatibility is wrong: %s %s %v", method, status, confirmed)
	}

	method, status, confirmed, err = syncedCreatePayment(syncOptionalPaymentMethod{
		Value: domain.PaymentMethodQRIS, Present: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if method != domain.PaymentMethodQRIS ||
		status != domain.PaymentStatusSuccess ||
		confirmed == nil ||
		*confirmed != 1 {
		t.Fatalf("new create payment is wrong: %s %s %v", method, status, confirmed)
	}

	method, legacy, err := syncedCorrectionPayment(syncOptionalPaymentMethod{})
	if err != nil {
		t.Fatal(err)
	}
	if method != domain.PaymentMethodLegacy || !legacy {
		t.Fatalf("old correction compatibility is wrong: %s legacy=%v", method, legacy)
	}

	legacyMethod := syncOptionalPaymentMethod{
		Value: domain.PaymentMethodLegacy, Present: true,
	}
	if _, _, _, err := syncedCreatePayment(legacyMethod); !domain.IsCode(err, domain.CodeValidation) {
		t.Fatalf("explicit legacy create must be rejected: %v", err)
	}
	if _, _, err := syncedCorrectionPayment(legacyMethod); !domain.IsCode(err, domain.CodeValidation) {
		t.Fatalf("explicit legacy correction must be rejected: %v", err)
	}

	explicitNull := syncOptionalPaymentMethod{Present: true, Null: true}
	if _, _, _, err := syncedCreatePayment(explicitNull); !domain.IsCode(err, domain.CodeValidation) {
		t.Fatalf("explicit null create must be rejected: %v", err)
	}
	if _, _, err := syncedCorrectionPayment(explicitNull); !domain.IsCode(err, domain.CodeValidation) {
		t.Fatalf("explicit null correction must be rejected: %v", err)
	}
}

func TestSyncOptionalPaymentMethodDistinguishesAbsentAndNull(t *testing.T) {
	t.Parallel()

	var absent struct {
		PaymentMethod syncOptionalPaymentMethod `json:"paymentMethod"`
	}
	if err := json.Unmarshal([]byte(`{}`), &absent); err != nil {
		t.Fatal(err)
	}
	if absent.PaymentMethod.Present {
		t.Fatal("absent paymentMethod was marked present")
	}

	var explicitNull struct {
		PaymentMethod syncOptionalPaymentMethod `json:"paymentMethod"`
	}
	if err := json.Unmarshal([]byte(`{"paymentMethod":null}`), &explicitNull); err != nil {
		t.Fatal(err)
	}
	if !explicitNull.PaymentMethod.Present || !explicitNull.PaymentMethod.Null {
		t.Fatalf("explicit null was not preserved: %+v", explicitNull.PaymentMethod)
	}

	var cash struct {
		PaymentMethod syncOptionalPaymentMethod `json:"paymentMethod"`
	}
	if err := json.Unmarshal([]byte(`{"paymentMethod":"cash"}`), &cash); err != nil {
		t.Fatal(err)
	}
	if !cash.PaymentMethod.Present ||
		cash.PaymentMethod.Null ||
		cash.PaymentMethod.Value != domain.PaymentMethodCash {
		t.Fatalf("cash was not decoded: %+v", cash.PaymentMethod)
	}
}
