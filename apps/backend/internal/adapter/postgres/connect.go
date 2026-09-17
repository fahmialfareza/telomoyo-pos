package postgres

import (
	"context"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/retry"
	"github.com/sirupsen/logrus"
)

const connectAttemptTimeout = 15 * time.Second

// OpenWithRetry opens the store, retrying with exponential backoff and full
// jitter. Serverless databases (e.g. Railway Postgres) may sleep through cold
// starts, so a single dial is not enough: keep retrying until the database
// wakes or the configured attempt budget is exhausted.
func OpenWithRetry(
	ctx context.Context,
	databaseURL string,
	maxAttempts int,
	maxBackoff time.Duration,
	logger *logrus.Logger,
	options ...Option,
) (*Store, error) {
	var store *Store
	err := retry.Do(ctx, maxAttempts, maxBackoff, logger, "connect postgres", func(attemptCtx context.Context) error {
		attempt, cancel := context.WithTimeout(attemptCtx, connectAttemptTimeout)
		defer cancel()
		opened, err := Open(attempt, databaseURL, options...)
		if err != nil {
			return err
		}
		store = opened
		return nil
	})
	if err != nil {
		return nil, err
	}
	return store, nil
}
