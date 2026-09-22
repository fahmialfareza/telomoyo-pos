package domain

import (
	"errors"
	"fmt"
)

const (
	CodeValidation               = "VALIDATION_ERROR"
	CodeUnauthorized             = "UNAUTHORIZED"
	CodeAccountAccessChanged     = "ACCOUNT_ACCESS_CHANGED"
	CodeInvalidCredentials       = "INVALID_CREDENTIALS"
	CodeForbidden                = "FORBIDDEN"
	CodePasswordChange           = "PASSWORD_CHANGE_REQUIRED"
	CodeNotFound                 = "NOT_FOUND"
	CodeConflict                 = "CONFLICT"
	CodeRevisionConflict         = "REVISION_CONFLICT"
	CodePaymentStateConflict     = "PAYMENT_STATE_CONFLICT"
	CodeFinalSuperadmin          = "FINAL_SUPERADMIN"
	CodeSelfMutation             = "SELF_PROTECTION"
	CodeIdempotencyMismatch      = "IDEMPOTENCY_MISMATCH"
	CodeSignatureInvalid         = "INVALID_TERMINAL_SIGNATURE"
	CodeRateLimited              = "RATE_LIMITED"
	CodeSandboxGenerationRetired = "SANDBOX_GENERATION_RETIRED"
	CodeSandboxDisabled          = "SANDBOX_DISABLED"
	CodeInternal                 = "INTERNAL_ERROR"
)

// Error is safe to serialize to an API consumer. Cause is retained for logs.
type Error struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Cause   error          `json:"-"`
}

func (e *Error) Error() string {
	if e.Cause == nil {
		return e.Code + ": " + e.Message
	}
	return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
}

func (e *Error) Unwrap() error { return e.Cause }

func NewError(code, message string) *Error {
	return &Error{Code: code, Message: message}
}

func Validation(message string, details map[string]any) *Error {
	return &Error{Code: CodeValidation, Message: message, Details: details}
}

func WrapInternal(err error, operation string) *Error {
	return &Error{
		Code:    CodeInternal,
		Message: "Terjadi kesalahan pada server",
		Cause:   fmt.Errorf("%s: %w", operation, err),
	}
}

func AsError(err error) *Error {
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr
	}
	return WrapInternal(err, "unclassified")
}

func IsCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr.Code == code
}
