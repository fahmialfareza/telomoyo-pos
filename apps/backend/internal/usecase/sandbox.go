package usecase

import (
	"context"
	"strings"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
)

const sandboxResetConfirmation = "RESET SANDBOX"

// Sandbox coordinates the control-plane lifecycle for the one shared Sandbox
// generation. Business mutations remain scoped by the immutable session-bound
// data space in their respective use cases and repositories.
type Sandbox struct {
	Repo          port.Repository
	Clock         port.Clock
	Enabled       bool
	QRISAmount    int64
	RetentionDays int
}

func (s Sandbox) Status(ctx context.Context, principal domain.Principal) (domain.SandboxStatus, error) {
	defer observability.StartSegment(ctx, "Usecase.Sandbox.Status")()
	if err := RequireTenant(principal); err != nil {
		return domain.SandboxStatus{}, err
	}
	status := domain.SandboxStatus{
		Enabled:           s.EnabledFor(principal),
		DataMode:          domain.DataModeSandbox,
		RetentionDays:     s.retentionDays(),
		SandboxQRISPolicy: principal.EffectiveSandboxQRISPolicy(),
	}
	if status.SandboxQRISPolicy == domain.SandboxQRISPolicyFixed1000 {
		amount := domain.SandboxQRISPaymentAmount
		status.QrisAmount = &amount
	}
	space, err := s.Repo.ActiveDataSpace(ctx, principal.TenantID, domain.DataModeSandbox)
	if status.Enabled && domain.IsCode(err, domain.CodeNotFound) {
		space, err = s.Repo.EnsureSandbox(ctx, principal.TenantID)
	}
	if err != nil {
		// A disabled feature may legitimately never have been activated. Once a
		// generation exists, keep returning its identity so clients can detect a
		// rollback without pretending the retained Sandbox data disappeared.
		if !status.Enabled && domain.IsCode(err, domain.CodeNotFound) {
			return status, nil
		}
		return domain.SandboxStatus{}, err
	}
	status.DataSpaceID = &space.ID
	status.Generation = &space.Generation
	return status, nil
}

func (s Sandbox) EnabledFor(principal domain.Principal) bool {
	if principal.SandboxEnabledOverride != nil {
		return *principal.SandboxEnabledOverride
	}
	return s.Enabled
}

func (s Sandbox) Configure(
	ctx context.Context,
	principal domain.Principal,
	input domain.ConfigureSandboxInput,
) (domain.SandboxStatus, error) {
	defer observability.StartSegment(ctx, "Usecase.Sandbox.Configure")()
	if err := RequireProduction(principal); err != nil {
		return domain.SandboxStatus{}, err
	}
	if err := RequireSuperadmin(principal); err != nil {
		return domain.SandboxStatus{}, err
	}
	if input.Enabled == nil {
		return domain.SandboxStatus{}, domain.Validation("Status Mode Uji wajib dipilih", map[string]any{"field": "enabled"})
	}
	if err := s.Repo.ConfigureSandbox(ctx, principal, *input.Enabled); err != nil {
		return domain.SandboxStatus{}, err
	}
	configured := *input.Enabled
	principal.SandboxEnabledOverride = &configured
	return s.Status(ctx, principal)
}

// Initialize intentionally performs no tenant work at process startup. Sandbox
// spaces are created lazily by Status/SwitchMode so a suspended original tenant
// cannot affect readiness or another tenant's production service.
func (s Sandbox) Initialize(ctx context.Context) (domain.DataSpace, error) {
	defer observability.StartSegment(ctx, "Usecase.Sandbox.Initialize")()
	return domain.DataSpace{}, nil
}

func (s Sandbox) Reset(
	ctx context.Context,
	principal domain.Principal,
	input domain.ResetSandboxInput,
) (domain.SandboxResetResult, error) {
	defer observability.StartSegment(ctx, "Usecase.Sandbox.Reset")()
	if err := RequireProduction(principal); err != nil {
		return domain.SandboxResetResult{}, err
	}
	if err := RequireSuperadmin(principal); err != nil {
		return domain.SandboxResetResult{}, err
	}
	if !s.EnabledFor(principal) {
		return domain.SandboxResetResult{}, domain.NewError(
			domain.CodeSandboxDisabled,
			"Mode Sandbox sedang dinonaktifkan",
		)
	}
	if input.ExpectedGeneration < 1 {
		return domain.SandboxResetResult{}, domain.Validation(
			"Generasi Sandbox tidak valid",
			map[string]any{"field": "expectedGeneration"},
		)
	}
	if strings.TrimSpace(input.Confirmation) != sandboxResetConfirmation {
		return domain.SandboxResetResult{}, domain.Validation(
			"Ketik RESET SANDBOX untuk mengonfirmasi reset",
			map[string]any{"field": "confirmation"},
		)
	}
	return s.Repo.ResetSandbox(
		ctx,
		principal,
		input.ExpectedGeneration,
		time.Duration(s.retentionDays())*24*time.Hour,
	)
}

func (s Sandbox) Cleanup(ctx context.Context) (domain.SandboxCleanupResult, error) {
	defer observability.StartSegment(ctx, "Usecase.Sandbox.Cleanup")()
	return s.Repo.CleanupExpiredSandboxes(ctx, s.now())
}

func (s Sandbox) now() time.Time {
	if s.Clock == nil {
		return time.Now().UTC()
	}
	return s.Clock.Now()
}

func (s Sandbox) retentionDays() int {
	if s.RetentionDays < 1 {
		return 30
	}
	return s.RetentionDays
}
