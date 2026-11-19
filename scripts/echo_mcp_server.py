"""Tiny MCP echo server used by the test scripts (stdio / sse / streamable-http)."""

import argparse

from mcp.server.mcpserver import MCPServer

mcp = MCPServer("echo")


@mcp.tool()
def echo(text: str) -> str:
    """Echo the given text back."""
    return "echo: " + text


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--transport", choices=["stdio", "sse", "streamable-http"], default="stdio")
    ap.add_argument("--port", type=int, default=9502)
    args = ap.parse_args()
    if args.transport == "stdio":
        mcp.run("stdio")
    else:
        mcp.run(args.transport, host="127.0.0.1", port=args.port)