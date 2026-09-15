package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/port"
	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/usecase"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type managementViewRepository struct {
	port.Repository
	port.TenancyRepository
	port.ManagementRepository
	current domain.Principal
	reads   int
}

func (r *managementViewRepository) PrincipalByTokenHash(context.Context, []byte) (domain.Principal, error) {
	return r.current, nil
}

func (r *managementViewRepository) PrincipalBySession(context.Context, uuid.UUID, []byte) (domain.Principal, error) {
	return r.current, nil
}

func (r *managementViewRepository) ListManagedUsers(context.Context, domain.Principal) ([]domain.User, error) {
	r.reads++
	return []domain.User{{ID: uuid.New(), FullName: "Kasir", Username: "kasir", Role: domain.RoleAdmin, IsActive: true}}, nil
}

func managementTestRouter(current domain.Principal) (*gin.Engine, *managementViewRepository) {
	repo := &managementViewRepository{current: current}
	return New(Dependencies{
		Repo:    repo,
		Auth:    usecase.Auth{Repo: repo, Tokens: retiredRecoveryTokens{}, Sessions: &retiredRecoverySessionIndex{values: map[string]uuid.UUID{}}},
		Tenancy: usecase.Tenancy{Repo: repo},
	}), repo
}

func TestOrganizationManagementRequiresReadyAccountSuperadmin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name      string
		kind      domain.ContextKind
		role      domain.Role
		temporary bool
		status    int
	}{
		{"account superadmin", domain.ContextAccount, domain.RoleSuperadmin, false, http.StatusOK},
		{"account admin", domain.ContextAccount, domain.RoleAdmin, false, http.StatusForbidden},
		{"tenant superadmin", domain.ContextTenant, domain.RoleSuperadmin, false, http.StatusOK},
		{"retired platform permission", domain.ContextPlatform, domain.RoleSuperadmin, false, http.StatusForbidden},
		{"temporary password", domain.ContextAccount, domain.RoleSuperadmin, true, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := domain.Principal{UserID: uuid.New(), SessionID: uuid.New(), ContextKind: test.kind, Role: test.role, MustChangePassword: test.temporary, IsPlatformAdmin: true}
			if test.kind == domain.ContextTenant {
				p.TenantID = domain.InitialTenantID()
				p.DataSpaceID = domain.LiveDataSpaceID()
				p.DataMode = domain.DataModeProduction
				p.MembershipID = uuid.New()
			}
			router, repo := managementTestRouter(p)
			r := httptest.NewRequest(http.MethodGet, "/api/v1/management/users", nil)
			r.Header.Set("Authorization", "Bearer management-token")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, r)
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if (repo.reads == 1) != (test.status == http.StatusOK) {
				t.Fatal("unauthorized management reached repository")
			}
		})
	}
}

func TestRetiredAdministrationEndpointsCannotBecomeGlobalMutations(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router, _ := managementTestRouter(domain.Principal{UserID: uuid.New(), SessionID: uuid.New(), ContextKind: domain.ContextTenant, Role: domain.RoleSuperadmin, TenantID: domain.InitialTenantID(), DataSpaceID: domain.LiveDataSpaceID(), DataMode: domain.DataModeProduction, MembershipID: uuid.New()})
	id := uuid.NewString()
	for _, test := range []struct {
		method, path string
		status       int
		code         string
	}{
		{http.MethodPost, "/auth/register-invitation", http.StatusGone, "INVITATIONS_REMOVED"},
		{http.MethodPost, "/auth/invitations/accept", http.StatusGone, "INVITATIONS_REMOVED"},
		{http.MethodPost, "/tenant/invitations", http.StatusGone, "INVITATIONS_REMOVED"},
		{http.MethodDelete, "/tenant/invitations/" + id, http.StatusGone, "INVITATIONS_REMOVED"},
		{http.MethodPatch, "/tenant/members/" + id, http.StatusUpgradeRequired, domain.CodeClientUpdateRequired},
		{http.MethodPatch, "/users/" + id, http.StatusUpgradeRequired, domain.CodeClientUpdateRequired},
		{http.MethodPost, "/users/" + id + "/reset-password", http.StatusUpgradeRequired, domain.CodeClientUpdateRequired},
		{http.MethodPost, "/platform/tenants", http.StatusUpgradeRequired, domain.CodeClientUpdateRequired},
		{http.MethodGet, "/platform/audit", http.StatusUpgradeRequired, domain.CodeClientUpdateRequired},
	} {
		t.Run(test.path, func(t *testing.T) {
			r := httptest.NewRequest(test.method, "/api/v1"+test.path, strings.NewReader(`{"role":"superadmin","active":false,"code":"obsolete"}`))
			r.Header.Set("Authorization", "Bearer management-token")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, r)
			if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestManagedUserPatchRejectsGlobalProfileAndPasswordFields(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router, _ := managementTestRouter(domain.Principal{UserID: uuid.New(), SessionID: uuid.New(), ContextKind: domain.ContextAccount, Role: domain.RoleSuperadmin})
	for _, body := range []string{`{"fullName":"Other person"}`, `{"username":"other"}`, `{"password":"not-accepted"}`, `{"role":"user"}`, `{}`} {
		r := httptest.NewRequest(http.MethodPatch, "/api/v1/management/users/"+uuid.NewString(), strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer management-token")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, r)
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body=%s status=%d response=%s", body, response.Code, response.Body.String())
		}
	}
}
