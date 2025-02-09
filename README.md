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
    *   The server also supports the `FAISS_INDEX_PATH` environment variable to specify the directory where the FAISS index is stored. If not set, it will default to `$HOME/knowledge_bases/.faiss`.
    *   The server requires the `HUGGINGFACE_API_KEY` environment variable to be set. This is the API key for the Hugging Face Inference API.
    *   The server supports the `HUGGINGFACE_MODEL_NAME` environment variable to specify the Hugging Face model to use. If not set, it will default to `sentence-transformers/all-MiniLM-L6-v2`.

    *   You can set the environment variable in your `.bashrc` or `.zshrc` file, or directly in the MCP settings.
    *   The server now uses a custom Hugging Face model instead of the GCP embedding service directly.

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
        "KNOWLEDGE_BASES_ROOT_DIR": "/path/to/knowledge_bases",
        "HUGGINGFACE_API_KEY": "YOUR_HUGGINGFACE_API_KEY",
        "HUGGINGFACE_MODEL_NAME": "sentence-transformers/all-MiniLM-L6-v2"
      },
      "description": "Retrieves the content of a specified knowledge base."
    },
    ```

    *   Replace `/path/to/knowledge-base-mcp-server` with the actual path to the server directory.
    *   Replace `/path/to/knowledge_bases` with the actual path to the knowledge bases directory.

6.  **Create knowledge base directories:**

    *   Create subdirectories within the `KNOWLEDGE_BASES_ROOT_DIR` for each knowledge base (e.g., `company`, `it_support`, `onboarding`).
    *   Place text files (e.g., `.txt`, `.md`) containing the knowledge base content within these subdirectories.

*   The server reads all text files within the specified knowledge base subdirectory.
*   The content of each file is then concatenated into a single string, with a separator added between each file's content.
*   The separator used is `#### File: <filename>`, where `<filename>` is the name of the file.

The server now uses a custom Hugging Face model instead of the GCP embedding service directly.

## Usage

The server exposes two tools:

*   `list_knowledge_bases`: Lists the available knowledge bases.
*   `retrieve_knowledge`: Retrieves the content of a specified knowledge base.

You can use these tools through the MCP interface.
