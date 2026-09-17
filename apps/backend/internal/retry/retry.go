// Package retry provides bounded exponential backoff with full jitter for
// operations that must survive transient outages, such as serverless databases
// sleeping through a cold start.
package retry

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/sirupsen/logrus"
)

// Delay grows exponentially from a 1s base, capped at maxBackoff, with full
// jitter (uniform in [delay/2, delay)) so concurrent replicas do not stampede
// the waking service.
func Delay(attempt int, maxBackoff time.Duration, randomFloat64 func() float64) time.Duration {
	delay := time.Second
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= maxBackoff {
			delay = maxBackoff
			break
		}
	}
	if delay > maxBackoff {
		delay = maxBackoff
	}
	jitter := 0.5 + randomFloat64()/2
	return time.Duration(float64(delay) * jitter)
}

// Sleep waits for delay unless the context is cancelled first.
func Sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Do runs apply until it succeeds or the attempt budget is exhausted,
// sleeping with capped exponential backoff and full jitter between attempts.
// The last error is wrapped with the attempt count.
func Do(
	ctx context.Context,
	maxAttempts int,
	maxBackoff time.Duration,
	logger *logrus.Logger,
	operation string,
	apply func(context.Context) error,
) error {
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := apply(ctx); err != nil {
			lastErr = err
			if attempt == maxAttempts {
				break
			}
			delay := Delay(attempt, maxBackoff, rand.Float64)
			logger.WithError(err).Warnf(
				"%s failed (attempt %d of %d); retrying in %s",
				operation, attempt, maxAttempts, delay,
			)
			if err := Sleep(ctx, delay); err != nil {
				return err
			}
			continue
		}
		if attempt > 1 {
			logger.Infof("%s succeeded on attempt %d of %d", operation, attempt, maxAttempts)
		}
		return nil
	}
	return fmt.Errorf("%s failed after %d attempts: %w", operation, maxAttempts, lastErr)
}
