"""Tiny MCP echo server used by scripts/test_new_features.py (stdio transport)."""

from mcp.server.mcpserver import MCPServer

mcp = MCPServer("echo")


@mcp.tool()
def echo(text: str) -> str:
    """Echo the given text back."""
    return "echo: " + text


if __name__ == "__main__":
    mcp.run("stdio")