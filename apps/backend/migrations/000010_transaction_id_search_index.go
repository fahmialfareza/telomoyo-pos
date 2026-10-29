package migrations

import (
	"context"
	"fmt"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"gorm.io/gorm"
)

// migrateTransactionIDSearchIndex serves the `id LIKE 'prefix%'` search in the
// transaction list and export. Under a non-C collation a default btree cannot
// answer LIKE prefixes; text_pattern_ops compares bytewise and can.
func migrateTransactionIDSearchIndex(ctx context.Context, tx *gorm.DB) error {
	defer observability.StartSegment(ctx, "Migrations.TransactionIDSearchIndex")()
	if err := tx.WithContext(ctx).Exec(
		`CREATE INDEX transactions_data_space_id_prefix_idx ON transactions(data_space_id,id text_pattern_ops)`,
	).Error; err != nil {
		return fmt.Errorf("create transaction id search index: %w", err)
	}
	return nil
}
