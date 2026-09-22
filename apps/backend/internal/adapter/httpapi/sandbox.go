package httpapi

import (
	"net/http"

	"github.com/fahmialfareza/sewa-motor-app/apps/backend/internal/domain"
	"github.com/gin-gonic/gin"
)

func (s *Server) sandboxStatus(c *gin.Context) {
	status, err := s.deps.Sandbox.Status(c.Request.Context(), principal(c))
	if err != nil {
		writeError(c, err)
		return
	}
	writeData(c, http.StatusOK, status)
}

func (s *Server) sandboxSettings(c *gin.Context) {
	var request domain.ConfigureSandboxInput
	if err := decodeJSON(c, &request); err != nil {
		writeError(c, err)
		return
	}
	status, err := s.deps.Sandbox.Configure(c.Request.Context(), principal(c), request)
	if err != nil {
		writeError(c, err)
		return
	}
	writeData(c, http.StatusOK, status)
}

func (s *Server) sandboxReset(c *gin.Context) {
	var request domain.ResetSandboxInput
	if err := decodeJSON(c, &request); err != nil {
		writeError(c, err)
		return
	}
	result, err := s.deps.Sandbox.Reset(c.Request.Context(), principal(c), request)
	if err != nil {
		writeError(c, err)
		return
	}
	writeData(c, http.StatusOK, result)
}
