# Knowledge Base MCP Server

This MCP server provides tools for listing and retrieving content from different knowledge bases.

## Setup Instructions

These instructions assume you have Node.js and npm installed on your system.

1.  **Clone the repository:**

    ```bash
    git clone <repository_url>
    cd knowledge-base-mcp-server
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Configure environment variables:**

    *   The server requires the `KNOWLEDGE_BASES_ROOT_DIR` environment variable to be set. This variable specifies the directory where the knowledge base subdirectories are located.
    *   If you don't set this variable, it will default to `$HOME/knowledge_bases`, where `$HOME` is the current user's home directory.

    *   You can set the environment variable in your `.bashrc` or `.zshrc` file, or directly in the MCP settings.

4.  **Build the server:**

    ```bash
    npm run build
    ```

5.  **Add the server to the MCP settings:**

    *   Edit the `cline_mcp_settings.json` file located at `/home/jean/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/settings/`.
    *   Add the following configuration to the `mcpServers` object:

    ```json
    "knowledge-base-mcp": {
      "command": "node",
      "args": [
        "/path/to/knowledge-base-mcp-server/build/index.js"
      ],
      "disabled": false,
      "autoApprove": [],
      "env": {
        "KNOWLEDGE_BASES_ROOT_DIR": "/path/to/knowledge_bases"
      },
      "description": "Retrieves the content of a specified knowledge base."
    }
    ```

    *   Replace `/path/to/knowledge-base-mcp-server` with the actual path to the server directory.
    *   Replace `/path/to/knowledge_bases` with the actual path to the knowledge bases directory.

6.  **Create knowledge base directories:**

    *   Create subdirectories within the `KNOWLEDGE_BASES_ROOT_DIR` for each knowledge base (e.g., `company`, `it_support`, `onboarding`).
    *   Place text files (e.g., `.txt`, `.md`) containing the knowledge base content within these subdirectories.

## Usage

The server exposes two tools:

*   `list_knowledge_bases`: Lists the available knowledge bases.
*   `retrieve_knowledge`: Retrieves the content of a specified knowledge base.

You can use these tools through the MCP interface.
