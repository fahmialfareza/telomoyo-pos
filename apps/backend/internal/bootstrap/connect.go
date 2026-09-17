package bootstrap

import (
	"context"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/retry"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/migrations"
	"github.com/sirupsen/logrus"
	"gorm.io/gorm"
)

// ApplyMigrationsWithRetry runs the schema migrations with a bounded
// exponential backoff. migrations.Apply is idempotent (schema_migrations
// records plus a transaction-scoped advisory lock), so re-running after a
// dropped connection is safe.
func ApplyMigrationsWithRetry(
	ctx context.Context,
	orm *gorm.DB,
	maxAttempts int,
	maxBackoff time.Duration,
	logger *logrus.Logger,
) error {
	return retry.Do(ctx, maxAttempts, maxBackoff, logger, "migrations", func(attemptCtx context.Context) error {
		return migrations.Apply(attemptCtx, orm)
	})
}
