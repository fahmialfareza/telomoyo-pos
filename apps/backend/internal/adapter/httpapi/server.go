package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/observability"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/usecase"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/newrelic/go-agent/v3/integrations/nrgin"
	"github.com/newrelic/go-agent/v3/newrelic"
	"github.com/sirupsen/logrus"
)

const (
	principalKey      = "principal"
	authenticationKey = "authentication"
	requestIDKey      = "request-id"
)

type Pinger interface {
	Ping(context.Context) error
}

type Dependencies struct {
	Repo         port.Repository
	Auth         usecase.Auth
	Users        usecase.Users
	Packages     usecase.Packages
	Transactions usecase.Transactions
	Reporting    usecase.Reporting
	Terminals    usecase.Terminals
	Sync         usecase.Sync
	Sandbox      usecase.Sandbox
	Tenancy      usecase.Tenancy
	Redis        Pinger
	Logger       *logrus.Logger
	NewRelic     *newrelic.Application
	LegalPages   LegalPageOptions
}

type Server struct {
	deps Dependencies
}

func New(deps Dependencies) *gin.Engine {
	server := &Server{deps: deps}
	router := gin.New()
	router.Use(
		nrgin.Middleware(deps.NewRelic),
		server.requestID(),
		server.transactionContext(),
		server.accessLog(),
		server.recovery(),
		bodyLimit(),
	)

	api := router.Group("/api/v1")
	// Public, read-only pages: no session, tenant, or database access required.
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		router.Handle(method, "/privacy-policy", server.privacyPolicy)
		router.Handle(method, "/account-deletion", server.accountDeletion)
		router.Handle(method, "/legal/styles.css", server.legalStyles)
	}
	api.GET("/health/live", server.live)
	api.GET("/health/ready", server.ready)
	api.POST("/auth/login", server.login)
	api.POST("/auth/register-invitation", server.invitationsRemoved)

	protected := api.Group("")
	protected.Use(server.authenticate())
	// These control-plane endpoints remain available to a previously issued
	// Sandbox session after the rollback flag is disabled. That lets the client
	// identify the state, log out, or rotate safely back into Production.
	protected.POST("/auth/logout", server.logout)
	protected.GET("/auth/contexts", server.authContexts)
	protected.POST("/auth/switch-context", server.switchContext)
	protected.POST("/auth/invitations/accept", server.invitationsRemoved)
	protected.POST("/auth/upgrade-session", server.upgradeSession)
	protected.POST("/profile/password", server.changePassword)
	protected.PATCH("/profile", server.updateOwnProfile)
	protected.GET("/platform/tenants", server.clientUpdateRequired)
	protected.POST("/platform/tenants", server.clientUpdateRequired)
	protected.POST("/platform/tenants/:tenantId/status", server.clientUpdateRequired)
	protected.POST("/platform/tenants/:tenantId/invitation", server.invitationsRemoved)
	protected.GET("/platform/audit", server.clientUpdateRequired)
	protected.GET("/management/tenants", server.platformTenants)
	protected.POST("/management/tenants", server.createTenant)
	protected.PATCH("/management/tenants/:tenantId", server.updateManagedTenant)
	protected.POST("/management/tenants/:tenantId/status", server.setTenantStatus)
	protected.GET("/management/audit", server.platformAudit)
	protected.GET("/management/users", server.managedUsers)
	protected.POST("/management/users", server.createManagedUser)
	protected.GET("/management/users/:userId", server.managedUser)
	protected.PATCH("/management/users/:userId", server.updateManagedUser)
	protected.POST("/management/users/:userId/reset-password", server.resetManagedPassword)
	protected.POST("/auth/switch-mode", server.switchMode)
	protected.GET("/profile", server.profile)
	protected.GET("/sandbox/status", server.sandboxStatus)
	protected.PUT("/sandbox/settings", server.sandboxSettings)

	operational := protected.Group("")
	operational.Use(server.requireTenant(), server.requireSandboxEnabled())
	operational.GET("/tenant/members", server.clientUpdateRequired)
	operational.PATCH("/tenant/members/:userId", server.clientUpdateRequired)
	operational.GET("/tenant/invitations", server.invitationsRemoved)
	operational.POST("/tenant/invitations", server.invitationsRemoved)
	operational.DELETE("/tenant/invitations/:invitationId", server.invitationsRemoved)
	operational.GET("/tenant/profile", server.tenantProfile)
	operational.PATCH("/tenant/profile", server.updateTenantProfile)
	operational.GET("/tenant/qris", server.tenantQRIS)
	operational.PUT("/tenant/qris", server.updateTenantQRIS)
	operational.POST("/sandbox/reset", server.requireProduction(), server.sandboxReset)

	operational.GET("/users", server.listUsers)
	operational.POST("/users", server.clientUpdateRequired)
	operational.GET("/users/:userId", server.getUser)
	operational.PATCH("/users/:userId", server.clientUpdateRequired)
	operational.DELETE("/users/:userId", server.clientUpdateRequired)
	operational.POST("/users/:userId/reset-password", server.clientUpdateRequired)

	operational.GET("/packages", server.listPackages)
	operational.POST("/packages", server.createPackage)
	operational.GET("/packages/:packageId", server.getPackage)
	operational.PATCH("/packages/:packageId", server.updatePackage)
	operational.DELETE("/packages/:packageId", server.deletePackage)

	operational.GET("/transactions", server.listTransactions)
	operational.POST("/transactions", server.createTransaction)
	operational.GET("/transactions/:transactionId", server.getTransaction)
	operational.DELETE("/transactions/:transactionId", server.deleteTransaction)
	operational.GET("/transactions/:transactionId/revisions", server.listRevisions)
	operational.POST("/transactions/:transactionId/revisions", server.correctTransaction)
	operational.POST("/transactions/:transactionId/payment-status", server.setTransactionPaymentStatus)
	operational.GET("/transactions/:transactionId/print-attempts", server.listPrintAttempts)
	operational.POST("/transactions/:transactionId/print-attempts", server.recordPrintAttempt)

	operational.GET("/statistics/dashboard", server.dashboard)
	operational.POST("/exports/transactions", server.exportTransactions)

	operational.POST("/terminals/enroll", server.requireProduction(), server.enrollTerminal)
	operational.GET("/terminals/current", server.currentTerminal)
	operational.POST("/terminals/:terminalId/revoke", server.requireProduction(), server.revokeTerminal)

	operational.POST("/sync/push", server.syncPush)
	operational.POST("/sync/revalidate", server.revalidateOrigins)
	operational.GET("/sync/pull", server.syncPull)

	// Conventional deployment probes remain available outside the versioned API.
	router.GET("/healthz", server.live)
	router.GET("/readyz", server.ready)
	return router
}

func (s *Server) transactionContext() gin.HandlerFunc {
	return func(c *gin.Context) {
		transaction := nrgin.Transaction(c)
		if transaction == nil {
			c.Next()
			return
		}
		transaction.AddAttribute("request.id", requestID(c))
		transaction.AddAttribute("http.route", c.FullPath())
		ctx := newrelic.NewContext(c.Request.Context(), transaction)
		// Production is the fail-closed/default scope for public endpoints and
		// authentication failures. Successful protected requests overwrite this
		// with their immutable session-bound scope in authenticate().
		ctx = observability.WithDataScope(ctx, observability.DataScope{ContextKind: "public"})
		c.Request = c.Request.WithContext(ctx)
		handlerName := c.HandlerName()
		if index := strings.LastIndex(handlerName, "."); index >= 0 {
			handlerName = handlerName[index+1:]
		}
		if handlerName == "" {
			handlerName = c.Request.Method + " " + c.FullPath()
		}
		segment := transaction.StartSegment("HTTP.Handler." + handlerName)
		defer segment.End()
		c.Next()
	}
}

func (s *Server) requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := uuid.Parse(c.GetHeader("X-Request-Id"))
		if err != nil {
			id = uuid.New()
		}
		value := id.String()
		c.Set(requestIDKey, value)
		c.Header("X-Request-Id", value)
		c.Next()
	}
}

func (s *Server) accessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		started := time.Now()
		c.Next()
		if s.deps.Logger != nil {
			fields := logrus.Fields{
				"request_id":  requestID(c),
				"method":      c.Request.Method,
				"path":        c.FullPath(),
				"status":      c.Writer.Status(),
				"duration_ms": time.Since(started).Milliseconds(),
				"client_ip":   c.ClientIP(),
			}
			for name, value := range observability.DataScopeLogFields(c.Request.Context()) {
				fields[name] = value
			}
			s.deps.Logger.
				WithContext(c.Request.Context()).
				WithFields(fields).
				Info("http_request")
		}
	}
}

func (s *Server) recovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if recovered := recover(); recovered != nil {
				err := fmt.Errorf("panic: %v", recovered)
				observability.NoticeError(c.Request.Context(), err, "http.panic")
				if s.deps.Logger != nil {
					s.deps.Logger.
						WithContext(c.Request.Context()).
						WithFields(observability.DataScopeLogFields(c.Request.Context())).
						WithError(err).
						WithField("request_id", requestID(c)).
						Error("panic")
				}
				writeError(c, domain.NewError(domain.CodeInternal, "Terjadi kesalahan pada server"))
				c.Abort()
			}
		}()
		c.Next()
	}
}

func bodyLimit() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		c.Next()
	}
}

func (s *Server) authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, err := usecase.BearerToken(c.GetHeader("Authorization"))
		if err != nil {
			writeError(c, domain.NewError(domain.CodeUnauthorized, "Token sesi wajib disertakan"))
			c.Abort()
			return
		}
		auth, err := s.deps.Auth.Authenticate(c.Request.Context(), token)
		// A recognized revoked/retired session still has a trusted immutable
		// scope. Attribute its denied request/error before returning, without
		// granting that principal access to the handler.
		if auth.Principal.SessionID != uuid.Nil {
			attachDataScope(c, auth.Principal)
		}
		if err != nil {
			// A Sandbox reset revokes the old session, but the exact reset
			// revocation may be consumed once by this endpoint to rotate into
			// the active generation (or back into Production). No other route
			// receives a principal for a revoked session.
			isRecoveryRoute := c.Request.Method == http.MethodPost &&
				c.FullPath() == "/api/v1/auth/switch-mode"
			contextRecovery := auth.RecoverableTenantAccess && auth.Principal.SessionID != uuid.Nil &&
				(c.FullPath() == "/api/v1/auth/contexts" || c.FullPath() == "/api/v1/auth/switch-context" || c.FullPath() == "/api/v1/auth/logout")
			if !contextRecovery && (!isRecoveryRoute ||
				!domain.IsCode(err, domain.CodeSandboxGenerationRetired) ||
				!auth.RecoverableRetiredSandbox || auth.Principal.SessionID == uuid.Nil ||
				auth.Principal.EffectiveDataMode() != domain.DataModeSandbox) {
				writeError(c, err)
				c.Abort()
				return
			}
		}
		c.Set(principalKey, auth.Principal)
		c.Set(authenticationKey, auth)
		attachDataScope(c, auth.Principal)
		if transaction := newrelic.FromContext(c.Request.Context()); transaction != nil {
			transaction.AddAttribute("user.id", auth.Principal.UserID.String())
			transaction.AddAttribute("user.role", string(auth.Principal.Role))
			if auth.RecoverableRetiredSandbox {
				transaction.AddAttribute("sandbox.session_recovery", true)
			}
			if auth.Principal.TerminalID != nil {
				transaction.AddAttribute("terminal.id", auth.Principal.TerminalID.String())
			}
		}
		c.Next()
	}
}

func attachDataScope(c *gin.Context, current domain.Principal) {
	scope := observability.DataScope{ContextKind: string(current.ContextKind)}
	if current.IsTenantContext() {
		scope.Mode = string(current.DataMode)
		scope.SpaceID = current.DataSpaceID.String()
		scope.TenantID = current.TenantID.String()
		scope.Generation = current.SandboxGeneration
		scope.SandboxQRISPolicy = string(current.EffectiveSandboxQRISPolicy())
		scope.ProtocolVersion = current.ProtocolVersion
	}
	c.Request = c.Request.WithContext(observability.WithDataScope(
		c.Request.Context(),
		scope,
	))
}

func (s *Server) requireTenant() gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := usecase.RequireTenant(principal(c)); err != nil {
			writeError(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}

func (s *Server) clientUpdateRequired(c *gin.Context) {
	writeError(c, domain.NewError(domain.CodeClientUpdateRequired, "Perbarui aplikasi untuk menggunakan pengelolaan organisasi. Undangan dan pengaturan anggota per bisnis tidak lagi digunakan"))
}

func (s *Server) requireProduction() gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := usecase.RequireProduction(principal(c)); err != nil {
			writeError(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}

func (s *Server) requireSandboxEnabled() gin.HandlerFunc {
	return func(c *gin.Context) {
		if principal(c).EffectiveDataMode() == domain.DataModeSandbox &&
			!s.deps.Sandbox.EnabledFor(principal(c)) {
			writeError(c, domain.NewError(
				domain.CodeSandboxDisabled,
				"Mode Uji telah dinonaktifkan. Kembali ke Mode Produksi untuk melanjutkan",
			))
			c.Abort()
			return
		}
		c.Next()
	}
}

func principal(c *gin.Context) domain.Principal {
	value, _ := c.Get(principalKey)
	result, _ := value.(domain.Principal)
	return result
}

func authentication(c *gin.Context) usecase.Authentication {
	value, _ := c.Get(authenticationKey)
	result, _ := value.(usecase.Authentication)
	if result.Principal.SessionID == uuid.Nil {
		result.Principal = principal(c)
	}
	return result
}

func requestID(c *gin.Context) string {
	value, _ := c.Get(requestIDKey)
	result, _ := value.(string)
	return result
}

func meta(c *gin.Context) gin.H {
	return gin.H{"requestId": requestID(c), "serverTime": time.Now().UTC()}
}

func writeData(c *gin.Context, status int, data any) {
	c.JSON(status, gin.H{"data": data, "meta": meta(c)})
}

func writePage(c *gin.Context, data any, nextCursor string) {
	writePageWithMore(c, data, nextCursor, nextCursor != "")
}

func writePageWithMore(c *gin.Context, data any, nextCursor string, hasMore bool) {
	pageMeta := meta(c)
	pageMeta["hasMore"] = hasMore
	if nextCursor == "" {
		pageMeta["nextCursor"] = nil
	} else {
		pageMeta["nextCursor"] = nextCursor
	}
	c.JSON(http.StatusOK, gin.H{"data": data, "meta": pageMeta})
}

func writeError(c *gin.Context, err error) {
	domainErr := domain.AsError(err)
	observability.NoticeError(c.Request.Context(), err, "http."+c.HandlerName())
	status := errorStatus(domainErr.Code)
	details := domainErr.Details
	if details == nil {
		details = map[string]any{}
	}
	c.JSON(status, gin.H{"error": gin.H{
		"code": domainErr.Code, "message": domainErr.Message,
		"details": details, "requestId": requestID(c),
	}})
}

func errorStatus(code string) int {
	switch code {
	case domain.CodeValidation:
		return http.StatusUnprocessableEntity
	case domain.CodeUnauthorized, domain.CodeInvalidCredentials, domain.CodeAccountAccessChanged:
		return http.StatusUnauthorized
	case "INVITATIONS_REMOVED":
		return http.StatusGone
	case domain.CodeForbidden, domain.CodeSandboxDisabled, domain.CodePasswordChange, domain.CodeSignatureInvalid, domain.CodeContextRequired, domain.CodeTenantSuspended, domain.CodeMembershipInactive, domain.CodeMembershipRevoked:
		return http.StatusForbidden
	case domain.CodeNotFound:
		return http.StatusNotFound
	case domain.CodeConflict, domain.CodeRevisionConflict, domain.CodePaymentStateConflict,
		domain.CodeFinalSuperadmin,
		domain.CodeSelfMutation, domain.CodeIdempotencyMismatch,
		domain.CodeSandboxGenerationRetired:
		return http.StatusConflict
	case domain.CodeRateLimited:
		return http.StatusTooManyRequests
	case domain.CodeClientUpdateRequired:
		return http.StatusUpgradeRequired
	case domain.CodeInvitationInvalid:
		return http.StatusUnprocessableEntity
	default:
		return http.StatusInternalServerError
	}
}

func decodeJSON(c *gin.Context, target any) error {
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return domain.Validation("Body JSON tidak valid", map[string]any{"reason": err.Error()})
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return domain.Validation("Body JSON hanya boleh berisi satu objek", nil)
	}
	return nil
}

func parseUUID(value, field string) (uuid.UUID, error) {
	id, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil {
		return uuid.Nil, domain.Validation("UUID tidak valid", map[string]any{"field": field})
	}
	return id, nil
}

func (s *Server) live(c *gin.Context) {
	writeData(c, http.StatusOK, gin.H{"status": "ok", "postgres": "ok", "redis": redisStatus(c, s.deps.Redis)})
}

func (s *Server) ready(c *gin.Context) {
	postgresStatus := "ok"
	status := "ok"
	httpStatus := http.StatusOK
	if err := s.deps.Repo.Ping(c.Request.Context()); err != nil {
		observability.NoticeError(c.Request.Context(), err, "health.postgres")
		postgresStatus = "unavailable"
		status = "unavailable"
		httpStatus = http.StatusServiceUnavailable
	}
	redis := redisStatus(c, s.deps.Redis)
	if status == "ok" && redis == "unavailable" {
		status = "degraded"
	}
	writeData(c, httpStatus, gin.H{"status": status, "postgres": postgresStatus, "redis": redis})
}

func redisStatus(c *gin.Context, pinger Pinger) string {
	if pinger == nil {
		return "unavailable"
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 250*time.Millisecond)
	defer cancel()
	if err := pinger.Ping(ctx); err != nil {
		return "unavailable"
	}
	return "ok"
}
