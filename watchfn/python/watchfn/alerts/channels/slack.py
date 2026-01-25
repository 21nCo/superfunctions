"""Slack notification channel."""

from typing import Dict, Any, Optional
import httpx


class SlackChannel:
    """Send notifications to Slack."""
    
    def __init__(self, webhook_url: str):
        self.webhook_url = webhook_url
    
    async def send(self, alert: Dict[str, Any]) -> None:
        """Send notification to Slack."""
        payload = self._build_payload(alert)
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                self.webhook_url,
                json=payload,
                headers={"Content-Type": "application/json"}
            )
            
            if response.status_code != 200:
                raise Exception(f"Slack webhook failed: {response.text}")
    
    def _build_payload(self, alert: Dict[str, Any]) -> Dict[str, Any]:
        """Build Slack webhook payload."""
        severity = alert.get("severity", "info")
        color = self._get_severity_color(severity)
        icon = self._get_severity_icon(severity)
        
        return {
            "text": f"{icon} Alert: {alert.get('name')}",
            "attachments": [{
                "color": color,
                "blocks": [
                    {
                        "type": "header",
                        "text": {
                            "type": "plain_text",
                            "text": f"{icon} {alert.get('name')}"
                        }
                    },
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": alert.get("description", "")
                        }
                    } if alert.get("description") else None,
                    {
                        "type": "section",
                        "fields": [
                            {
                                "type": "mrkdwn",
                                "text": f"*Severity:*\n{severity.upper()}"
                            },
                            {
                                "type": "mrkdwn",
                                "text": f"*Time:*\n{alert.get('timestamp', 0)}"
                            }
                        ]
                    }
                ]
            }]
        }
    
    def _get_severity_color(self, severity: str) -> str:
        """Get color for severity."""
        colors = {
            "critical": "#DC143C",
            "warning": "#FFA500",
            "info": "#4169E1"
        }
        return colors.get(severity, "#808080")
    
    def _get_severity_icon(self, severity: str) -> str:
        """Get icon for severity."""
        icons = {
            "critical": "🚨",
            "warning": "⚠️",
            "info": "ℹ️"
        }
        return icons.get(severity, "📊")
