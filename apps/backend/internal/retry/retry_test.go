package retry

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

func noJitter() func() float64 { return func() float64 { return 1 } }

func TestDelayGrowsExponentiallyAndCaps(t *testing.T) {
	t.Parallel()

	maxBackoff := 10 * time.Second
	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{attempt: 1, want: time.Second},
		{attempt: 2, want: 2 * time.Second},
		{attempt: 3, want: 4 * time.Second},
		{attempt: 4, want: 8 * time.Second},
		{attempt: 5, want: 10 * time.Second},
		{attempt: 12, want: 10 * time.Second},
	}
	for _, test := range tests {
		if got := Delay(test.attempt, maxBackoff, noJitter()); got != test.want {
			t.Fatalf("Delay(attempt=%d) = %s, want %s", test.attempt, got, test.want)
		}
	}
}

func TestDelayAppliesJitterWithinHalfAndFullDelay(t *testing.T) {
	t.Parallel()

	// rand.Float64 is documented to return values in [0, 1), so the jittered
	// delay always lands in [delay/2, delay).
	for attempt := 1; attempt <= 8; attempt++ {
		for i := 0; i < 100; i++ {
			got := Delay(attempt, time.Minute, func() float64 {
				return float64(i) / 100
			})
			delay := Delay(attempt, time.Minute, noJitter())
			if got < delay/2 || got > delay {
				t.Fatalf("Delay(attempt=%d) = %s outside [%s, %s]", attempt, got, delay/2, delay)
			}
		}
	}
}

func TestDoSucceedsAfterTransientFailures(t *testing.T) {
	t.Parallel()

	logger := logrus.New()
	logger.SetLevel(logrus.PanicLevel)
	calls := 0
	boom := errors.New("database is sleeping")
	err := Do(context.Background(), 5, time.Nanosecond, logger, "op", func(context.Context) error {
		calls++
		if calls < 3 {
			return boom
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestDoExhaustsAttemptsAndWrapsLastError(t *testing.T) {
	t.Parallel()

	logger := logrus.New()
	logger.SetLevel(logrus.PanicLevel)
	boom := errors.New("still sleeping")
	calls := 0
	err := Do(context.Background(), 3, time.Nanosecond, logger, "op", func(context.Context) error {
		calls++
		return boom
	})
	if err == nil {
		t.Fatal("Do succeeded, want exhaustion error")
	}
	if !errors.Is(err, boom) {
		t.Fatalf("Do error %v does not wrap %v", err, boom)
	}
	if !strings.Contains(err.Error(), "3 attempts") {
		t.Fatalf("Do error %v missing attempt count", err)
	}
	if calls != 3 {
		t.Fatalf("calls = %d, want 3", calls)
	}
}

func TestDoStopsWhenContextCancelled(t *testing.T) {
	t.Parallel()

	logger := logrus.New()
	logger.SetLevel(logrus.PanicLevel)
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	err := Do(ctx, 10, time.Hour, logger, "op", func(context.Context) error {
		calls++
		cancel()
		return errors.New("fail")
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Do error = %v, want context.Canceled", err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d, want 1", calls)
	}
}
