"""Template engine for email templates."""

import html
import re
from typing import Any, Optional

from ..errors import TemplateError
from ..models import EmailTemplate


class TemplateEngine:
    """Lightweight template engine for email templates."""

    def render(self, template: str, data: dict[str, Any]) -> str:
        """Render a template with data.

        Args:
            template: Template string with {{variable}} placeholders
            data: Data dictionary for variable substitution

        Returns:
            Rendered template string

        Raises:
            TemplateError: If template rendering fails
        """
        try:
            result = template

            # Replace variables {{variable}}
            def replace_variable(match: re.Match) -> str:
                var_name = match.group(1).strip()
                value = data.get(var_name, "")
                # HTML escape by default
                return html.escape(str(value)) if value is not None else ""

            result = re.sub(r"\{\{([^}]+)\}\}", replace_variable, result)

            # Handle simple conditionals {{#if variable}}...{{/if}}
            result = self._process_conditionals(result, data)

            # Handle simple loops {{#each items}}...{{/each}}
            result = self._process_loops(result, data)

            return result
        except Exception as e:
            raise TemplateError(f"Template rendering failed: {e}")

    def validate(self, template: EmailTemplate, data: dict[str, Any]) -> dict[str, Any]:
        """Validate template data.

        Args:
            template: Email template
            data: Data to validate

        Returns:
            Validation result with 'valid' and 'errors' keys
        """
        errors = []
        
        # Check all required variables are present
        for var in template.variables:
            if var not in data:
                errors.append(f"Missing required variable: {var}")
        
        # Warn about unused variables
        warnings = []
        for key in data.keys():
            if key not in template.variables:
                warnings.append(f"Unused variable: {key}")
        
        return {
            "valid": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
        }

    def extract_variables(self, template: str) -> list[str]:
        """Extract variable names from a template.

        Args:
            template: Template string

        Returns:
            List of variable names
        """
        variables = set()
        
        # Find all {{variable}} patterns
        for match in re.finditer(r"\{\{([^}#/]+)\}\}", template):
            var_name = match.group(1).strip()
            variables.add(var_name)
        
        return sorted(list(variables))

    def _process_conditionals(self, template: str, data: dict[str, Any]) -> str:
        """Process {{#if variable}}...{{/if}} conditionals."""
        def replace_conditional(match: re.Match) -> str:
            var_name = match.group(1).strip()
            content = match.group(2)
            
            # Check if variable is truthy
            if data.get(var_name):
                return content
            return ""
        
        # Match {{#if var}}content{{/if}}
        pattern = r"\{\{#if\s+([^}]+)\}\}(.*?)\{\{/if\}\}"
        return re.sub(pattern, replace_conditional, template, flags=re.DOTALL)

    def _process_loops(self, template: str, data: dict[str, Any]) -> str:
        """Process {{#each items}}...{{/each}} loops."""
        def replace_loop(match: re.Match) -> str:
            var_name = match.group(1).strip()
            content = match.group(2)
            
            items = data.get(var_name, [])
            if not isinstance(items, list):
                return ""
            
            result = []
            for item in items:
                # Simple variable replacement within loop
                item_content = content
                if isinstance(item, dict):
                    for key, value in item.items():
                        item_content = item_content.replace(
                            f"{{{{{key}}}}}",
                            html.escape(str(value)) if value is not None else ""
                        )
                else:
                    # If item is not a dict, use it as the value
                    item_content = item_content.replace(
                        "{{this}}",
                        html.escape(str(item)) if item is not None else ""
                    )
                result.append(item_content)
            
            return "".join(result)
        
        # Match {{#each items}}content{{/each}}
        pattern = r"\{\{#each\s+([^}]+)\}\}(.*?)\{\{/each\}\}"
        return re.sub(pattern, replace_loop, template, flags=re.DOTALL)


class TemplateRegistry:
    """Registry for email templates."""

    def __init__(self) -> None:
        """Initialize the template registry."""
        self._templates: dict[str, EmailTemplate] = {}
        self._load_default_templates()

    def register(self, template: EmailTemplate) -> None:
        """Register a template.

        Args:
            template: Email template to register
        """
        self._templates[template.id] = template

    def get(self, template_id: str) -> Optional[EmailTemplate]:
        """Get a template by ID.

        Args:
            template_id: Template ID

        Returns:
            Email template or None if not found
        """
        return self._templates.get(template_id)

    def list(self) -> list[EmailTemplate]:
        """List all registered templates.

        Returns:
            List of all email templates
        """
        return list(self._templates.values())

    def _load_default_templates(self) -> None:
        """Load default built-in templates."""
        # Welcome email template
        welcome_template = EmailTemplate(
            id="welcome-email",
            name="Welcome Email",
            subject="Welcome to {{appName}}!",
            html="""
            <html>
            <body>
                <h1>Welcome, {{userName}}!</h1>
                <p>Thank you for joining {{appName}}. We're excited to have you on board.</p>
                {{#if verificationUrl}}
                <p>Please verify your email address by clicking the link below:</p>
                <p><a href="{{verificationUrl}}">Verify Email</a></p>
                {{/if}}
                <p>Best regards,<br>The {{appName}} Team</p>
            </body>
            </html>
            """,
            text="""
            Welcome, {{userName}}!
            
            Thank you for joining {{appName}}. We're excited to have you on board.
            
            Best regards,
            The {{appName}} Team
            """,
            variables=["userName", "appName", "verificationUrl"],
        )
        self.register(welcome_template)

        # Password reset template
        password_reset_template = EmailTemplate(
            id="password-reset",
            name="Password Reset",
            subject="Reset your password for {{appName}}",
            html="""
            <html>
            <body>
                <h1>Password Reset Request</h1>
                <p>Hi {{userName}},</p>
                <p>We received a request to reset your password for your {{appName}} account.</p>
                <p>Click the link below to reset your password:</p>
                <p><a href="{{resetUrl}}">Reset Password</a></p>
                <p>This link will expire in {{expiryHours}} hours.</p>
                <p>If you didn't request this, you can safely ignore this email.</p>
                <p>Best regards,<br>The {{appName}} Team</p>
            </body>
            </html>
            """,
            text="""
            Password Reset Request
            
            Hi {{userName}},
            
            We received a request to reset your password for your {{appName}} account.
            
            Reset your password: {{resetUrl}}
            
            This link will expire in {{expiryHours}} hours.
            
            If you didn't request this, you can safely ignore this email.
            
            Best regards,
            The {{appName}} Team
            """,
            variables=["userName", "appName", "resetUrl", "expiryHours"],
        )
        self.register(password_reset_template)

        # Generic notification template
        notification_template = EmailTemplate(
            id="notification",
            name="Notification",
            subject="{{subject}}",
            html="""
            <html>
            <body>
                <h1>{{title}}</h1>
                <p>{{message}}</p>
                {{#if actionUrl}}
                <p><a href="{{actionUrl}}">{{actionText}}</a></p>
                {{/if}}
                <p>Best regards,<br>{{appName}}</p>
            </body>
            </html>
            """,
            text="""
            {{title}}
            
            {{message}}
            
            Best regards,
            {{appName}}
            """,
            variables=["subject", "title", "message", "appName", "actionUrl", "actionText"],
        )
        self.register(notification_template)
