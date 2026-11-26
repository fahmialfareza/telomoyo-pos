package observability

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	contextlogrus "github.com/newrelic/go-agent/v3/integrations/logcontext-v2/nrlogrus"
	agentlogrus "github.com/newrelic/go-agent/v3/integrations/nrlogrus"
	"github.com/newrelic/go-agent/v3/newrelic"
	"github.com/sirupsen/logrus"
)

type Config struct {
	Enabled            bool
	AppName            string
	LicenseKey         string
	DistributedTracing bool
	LogForwarding      bool
	LogLevel           string
}

type Runtime struct {
	App     *newrelic.Application
	Logger  *logrus.Logger
	enabled bool
}

// DataScope identifies the immutable production or sandbox boundary attached
// to an authenticated session. It intentionally contains no domain types so
// observability can remain below the HTTP and use-case layers.
type DataScope struct {
	TenantID          string
	ContextKind       string
	Mode              string
	SpaceID           string
	Generation        int64
	ProtocolVersion   int
	SandboxQRISPolicy string
}

type dataScopeContextKey struct{}

type dataScopeLogHook struct{}

var defaultLogger = newBaseLogger("info")

func New(config Config) (*Runtime, error) {
	logger := newBaseLogger(config.LogLevel)
	app, err := newrelic.NewApplication(
		newrelic.ConfigEnabled(config.Enabled),
		newrelic.ConfigAppName(config.AppName),
		newrelic.ConfigLicense(config.LicenseKey),
		newrelic.ConfigDistributedTracerEnabled(config.DistributedTracing),
		newrelic.ConfigAppLogEnabled(true),
		// Expected client responses are not server failures; keep them out of
		// the error rate so real 5xx errors stay visible.
		func(cfg *newrelic.Config) {
			cfg.ErrorCollector.IgnoreStatusCodes = append(cfg.ErrorCollector.IgnoreStatusCodes,
				400, 401, 403, 404, 409, 410, 422, 426, 429)
		},
		newrelic.ConfigAppLogForwardingEnabled(config.LogForwarding),
		newrelic.ConfigAppLogDecoratingEnabled(!config.LogForwarding),
		agentlogrus.ConfigLogger(logger),
	)
	if err != nil {
		return nil, fmt.Errorf("initialize New Relic: %w", err)
	}

	logger.SetFormatter(contextlogrus.NewFormatter(app, &logrus.JSONFormatter{
		TimestampFormat: time.RFC3339Nano,
	}))
	defaultLogger = logger
	return &Runtime{App: app, Logger: logger, enabled: config.Enabled}, nil
}

func (r *Runtime) WaitForConnection(timeout time.Duration) error {
	if r == nil || !r.enabled {
		return nil
	}
	return r.App.WaitForConnection(timeout)
}

func (r *Runtime) Shutdown(timeout time.Duration) {
	if r == nil || r.App == nil {
		return
	}
	r.App.Shutdown(timeout)
}

func Logger() *logrus.Logger {
	return defaultLogger
}

func StartSegment(ctx context.Context, name string) func() {
	transaction := newrelic.FromContext(ctx)
	if transaction == nil {
		return func() {}
	}
	segment := transaction.StartSegment(name)
	return segment.End
}

// WithDataScope correlates every downstream segment, noticed error, and
// structured log with the request's server-authorized data boundary.
func WithDataScope(ctx context.Context, scope DataScope) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if transaction := newrelic.FromContext(ctx); transaction != nil {
		if scope.TenantID != "" {
			transaction.AddAttribute("tenant.id", scope.TenantID)
		}
		if scope.ContextKind != "" {
			transaction.AddAttribute("auth.context", scope.ContextKind)
		}
		if scope.Mode != "" {
			transaction.AddAttribute("data.mode", scope.Mode)
		}
		if scope.SpaceID != "" {
			transaction.AddAttribute("data.space_id", scope.SpaceID)
		}
		if scope.Generation > 0 {
			transaction.AddAttribute("data.generation", scope.Generation)
		}
		if scope.ProtocolVersion > 0 {
			transaction.AddAttribute("auth.protocol_version", scope.ProtocolVersion)
		}
		if scope.SandboxQRISPolicy != "" {
			transaction.AddAttribute("payment.sandbox_qris_policy", scope.SandboxQRISPolicy)
		}
	}
	return context.WithValue(ctx, dataScopeContextKey{}, scope)
}

func DataScopeFromContext(ctx context.Context) (DataScope, bool) {
	if ctx == nil {
		return DataScope{}, false
	}
	scope, ok := ctx.Value(dataScopeContextKey{}).(DataScope)
	return scope, ok
}

func DataScopeLogFields(ctx context.Context) logrus.Fields {
	scope, ok := DataScopeFromContext(ctx)
	if !ok {
		return logrus.Fields{}
	}
	fields := logrus.Fields{}
	if scope.TenantID != "" {
		fields["tenant.id"] = scope.TenantID
	}
	if scope.ContextKind != "" {
		fields["auth.context"] = scope.ContextKind
	}
	if scope.Mode != "" {
		fields["data.mode"] = scope.Mode
	}
	if scope.SpaceID != "" {
		fields["data.space_id"] = scope.SpaceID
	}
	if scope.Generation > 0 {
		fields["data.generation"] = scope.Generation
	}
	if scope.ProtocolVersion > 0 {
		fields["auth.protocol_version"] = scope.ProtocolVersion
	}
	if scope.SandboxQRISPolicy != "" {
		fields["payment.sandbox_qris_policy"] = scope.SandboxQRISPolicy
	}
	return fields
}

func (dataScopeLogHook) Levels() []logrus.Level { return logrus.AllLevels }

func (dataScopeLogHook) Fire(entry *logrus.Entry) error {
	for name, value := range DataScopeLogFields(entry.Context) {
		if _, exists := entry.Data[name]; !exists {
			entry.Data[name] = value
		}
	}
	return nil
}

func NoticeError(ctx context.Context, err error, operation string) {
	if err == nil {
		return
	}
	attributes := map[string]any{"operation": operation}
	for name, value := range DataScopeLogFields(ctx) {
		attributes[name] = value
	}
	if transaction := newrelic.FromContext(ctx); transaction != nil {
		transaction.NoticeError(newrelic.Error{
			Message:    err.Error(),
			Class:      fmt.Sprintf("%T", err),
			Attributes: attributes,
			Stack:      newrelic.NewStackTrace(),
		})
	}
	Logger().
		WithContext(ctx).
		WithFields(DataScopeLogFields(ctx)).
		WithError(err).
		WithField("operation", operation).
		Error("operation failed")
}

func newBaseLogger(level string) *logrus.Logger {
	logger := logrus.New()
	logger.AddHook(dataScopeLogHook{})
	logger.SetOutput(os.Stdout)
	logger.SetFormatter(&logrus.JSONFormatter{
		TimestampFormat: time.RFC3339Nano,
	})
	parsed, err := logrus.ParseLevel(strings.ToLower(strings.TrimSpace(level)))
	if err != nil {
		parsed = logrus.InfoLevel
	}
	logger.SetLevel(parsed)
	return logger
}
