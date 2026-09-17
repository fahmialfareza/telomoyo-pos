package migrations

import (
	"context"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"gorm.io/gorm"
)

// confirmedPaymentModel is deliberately scoped to migration 000007. Earlier
// migrations keep their own immutable model descriptions.
type confirmedPaymentModel struct {
	ID                       string     `gorm:"column:id;type:text;primaryKey"`
	CurrentRevision          int        `gorm:"column:current_revision;type:integer;not null"`
	PaymentStatus            string     `gorm:"column:payment_status;type:text;not null"`
	PaymentConfirmedRevision *int       `gorm:"column:payment_confirmed_revision;type:integer"`
	DeletedAt                *time.Time `gorm:"column:deleted_at;type:timestamptz"`
}

func (confirmedPaymentModel) TableName() string { return "transactions" }

func migratePaymentsAutoConfirmed(ctx context.Context, tx *gorm.DB) error {
	defer observability.StartSegment(ctx, "Migrations.PaymentsAutoConfirmed")()

	// The payment confirmation step was removed: every transaction is
	// successful from creation, so lingering pending/failed rows are promoted
	// to match. Both columns update in one statement to satisfy the
	// transactions_payment_confirmation_shape check constraint.
	if err := tx.Model(&confirmedPaymentModel{}).
		Where("payment_status <> ?", "success").
		UpdateColumns(map[string]any{
			"payment_status":             "success",
			"payment_confirmed_revision": gorm.Expr("current_revision"),
		}).Error; err != nil {
		return err
	}
	return nil
}
