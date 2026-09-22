package migrations

import (
	"context"
	"fmt"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"gorm.io/gorm"
)

// migrateTenantSandboxSetting adds an explicit per-business override. NULL is
// intentional: existing and newly created tenants inherit SANDBOX_ENABLED until
// a Superadmin chooses a value for that business.
func migrateTenantSandboxSetting(ctx context.Context, tx *gorm.DB) error {
	defer observability.StartSegment(ctx, "Migrations.TenantSandboxSetting")()
	if err := tx.WithContext(ctx).Exec(
		`ALTER TABLE tenants ADD COLUMN sandbox_enabled_override boolean`,
	).Error; err != nil {
		return fmt.Errorf("add tenant sandbox setting: %w", err)
	}
	return nil
}
