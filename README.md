# Knowledge Base MCP Server

[![smithery badge](https://smithery.ai/badge/@jeanibarz/knowledge-base-mcp-server)](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server)
This MCP server provides tools for listing and retrieving content from different knowledge bases.

<a href="https://glama.ai/mcp/servers/n0p6v0o0a4">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/n0p6v0o0a4/badge" alt="Knowledge Base Server MCP server" />
</a>

## Setup Instructions

These instructions assume you have Node.js and npm installed on your system.

### Installing via Smithery

To install Knowledge Base Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server):

```bash
npx -y @smithery/cli install @jeanibarz/knowledge-base-mcp-server --client claude
```

### Manual Installation
**Prerequisites**

*   [Node.js](https://nodejs.org/) (version 16 or higher)
*   [npm](https://www.npmjs.com/) (Node Package Manager)

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

    This server supports two embedding providers: **Ollama** (recommended for reliability) and **HuggingFace** (fallback option).

    ### Option 1: Ollama Configuration (Recommended)
    
    *   Set `EMBEDDING_PROVIDER=ollama` to use local Ollama embeddings
    *   Install [Ollama](https://ollama.ai/) and pull an embedding model: `ollama pull dengcao/Qwen3-Embedding-0.6B:Q8_0`
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=ollama
        OLLAMA_BASE_URL=http://localhost:11434  # Default Ollama URL
        OLLAMA_MODEL=dengcao/Qwen3-Embedding-0.6B:Q8_0          # Default embedding model
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```

    ### Option 2: HuggingFace Configuration (Fallback)
    
    *   Set `EMBEDDING_PROVIDER=huggingface` or leave unset (default)
    *   Obtain a free API key from [HuggingFace](https://huggingface.co/)
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=huggingface          # Optional, this is the default
        HUGGINGFACE_API_KEY=your_api_key_here
        HUGGINGFACE_MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```

    ### Additional Configuration
    
    *   The server supports the `FAISS_INDEX_PATH` environment variable to specify the path to the FAISS index. If not set, it will default to `$HOME/knowledge_bases/.faiss`.
    *   Logging can be routed to a file by setting `LOG_FILE=/path/to/logs/knowledge-base.log`. Log verbosity defaults to `info` and can be adjusted with `LOG_LEVEL=debug|info|warn|error`.
    *   You can set these environment variables in your `.bashrc` or `.zshrc` file, or directly in the MCP settings.

4.  **Build the server:**

    ```bash
    npm run build
    ```

5.  **Add the server to the MCP settings:**

    *   Edit the `cline_mcp_settings.json` file located at `/home/jean/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/settings/`.
    *   Add the following configuration to the `mcpServers` object:

    *   **Option 1: Ollama Configuration**

    ```json
    "knowledge-base-mcp-ollama": {
      "command": "node",
      "args": [
        "/path/to/knowledge-base-mcp-server/build/index.js"
      ],
      "disabled": false,
      "autoApprove": [],
      "env": {
        "KNOWLEDGE_BASES_ROOT_DIR": "/path/to/knowledge_bases",
        "EMBEDDING_PROVIDER": "ollama",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "dengcao/Qwen3-Embedding-0.6B:Q8_0"
      },
      "description": "Retrieves similar chunks from the knowledge base based on a query using Ollama."
    },
    ```

    *   **Option 2: HuggingFace Configuration**

    ```json
    "knowledge-base-mcp-huggingface": {
      "command": "node",
      "args": [
        "/path/to/knowledge-base-mcp-server/build/index.js"
      ],
      "disabled": false,
      "autoApprove": [],
      "env": {
        "KNOWLEDGE_BASES_ROOT_DIR": "/path/to/knowledge_bases",
        "EMBEDDING_PROVIDER": "huggingface",
        "HUGGINGFACE_API_KEY": "YOUR_HUGGINGFACE_API_KEY",
        "HUGGINGFACE_MODEL_NAME": "sentence-transformers/all-MiniLM-L6-v2"
      },
      "description": "Retrieves similar chunks from the knowledge base based on a query using HuggingFace."
    },
    ```

    *   **Note:** You only need to add one of the above configurations (either Ollama or HuggingFace) to your `cline_mcp_settings.json` file, depending on your preferred embedding provider.
    ```

    *   Replace `/path/to/knowledge-base-mcp-server` with the actual path to the server directory.
    *   Replace `/path/to/knowledge_bases` with the actual path to the knowledge bases directory.

6.  **Create knowledge base directories:**

    *   Create subdirectories within the `KNOWLEDGE_BASES_ROOT_DIR` for each knowledge base (e.g., `company`, `it_support`, `onboarding`).
    *   Place text files (e.g., `.txt`, `.md`) containing the knowledge base content within these subdirectories.

*   The server recursively reads all text files (e.g., `.txt`, `.md`) within the specified knowledge base subdirectories.
*   The server skips hidden files and directories (those starting with a `.`).
*   For each file, the server calculates the SHA256 hash and stores it in a file with the same name in a hidden `.index` subdirectory. This hash is used to determine if the file has been modified since the last indexing.
*   The file content is splitted into chunks using the `MarkdownTextSplitter` from `langchain/text_splitter`.
*   The content of each chunk is then added to a FAISS index, which is used for similarity search.
*   The FAISS index is automatically initialized when the server starts. It checks for changes in the knowledge base files and updates the index accordingly.

## Usage

The server exposes two tools:

*   `list_knowledge_bases`: Lists the available knowledge bases.
*   `retrieve_knowledge`: Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 document chunks are returned with a score below a threshold of 2. A different threshold can optionally be provided using the `threshold` parameter.

You can use these tools through the MCP interface.

The `retrieve_knowledge` tool performs a semantic search using a FAISS index. The index is automatically updated when the server starts or when a file in a knowledge base is modified.

The output of the `retrieve_knowledge` tool is a markdown formatted string with the following structure:

````markdown
## Semantic Search Results

**Result 1:**

[Content of the most similar chunk]

**Source:**
```json
{
  "source": "[Path to the file containing the chunk]"
}
```

---

**Result 2:**

[Content of the second most similar chunk]

**Source:**
```json
{
  "source": "[Path to the file containing the chunk]"
}
```

> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.
````

Each result includes the content of the most similar chunk, the source file, and a similarity score.

## Troubleshooting & Logging

- Set `LOG_FILE` to capture structured logs (JSON-RPC traffic continues to use stdout). This is especially helpful when diagnosing MCP handshake errors because all diagnostic messages are written to stderr and the optional log file.
- Permission errors when creating or updating the FAISS index are surfaced with explicit messages in both the console and the log file. Verify that the process can write to `FAISS_INDEX_PATH` and the `.index` directories inside each knowledge base.
- Run `npm test` to execute the Jest suite (serialised with `--runInBand`) that covers logger fallback behaviour and FAISS permission handling.
