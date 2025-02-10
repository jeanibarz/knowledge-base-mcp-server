# Knowledge Base MCP Server

This MCP server provides tools for listing and retrieving content from different knowledge bases.

## Setup Instructions

These instructions assume you have Node.js and npm installed on your system.

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

    *   The server requires the `HUGGINGFACE_API_KEY` environment variable to be set. This is the API key for the Hugging Face Inference API, which is used to generate embeddings for the knowledge base content. You can obtain a free API key from the Hugging Face website ([https://huggingface.co/](https://huggingface.co/)).
    *   The server requires the `KNOWLEDGE_BASES_ROOT_DIR` environment variable to be set. This variable specifies the directory where the knowledge base subdirectories are located. If you don't set this variable, it will default to `$HOME/knowledge_bases`, where `$HOME` is the current user's home directory.
    *   The server supports the `FAISS_INDEX_PATH` environment variable to specify the path to the FAISS index. If not set, it will default to `$HOME/knowledge_bases/.faiss`.
    *   The server supports the `HUGGINGFACE_MODEL_NAME` environment variable to specify the Hugging Face model to use for generating embeddings. If not set, it will default to `sentence-transformers/all-MiniLM-L6-v2`.
    *   You can set these environment variables in your `.bashrc` or `.zshrc` file, or directly in the MCP settings.

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
      },
      "description": "Retrieves similar chunks from the knowledge base based on a query."
    },
    ```

    *   Replace `/path/to/knowledge-base-mcp-server` with the actual path to the server directory.
    *   Replace `/path/to/knowledge_bases` with the actual path to the knowledge bases directory.

6.  **Create knowledge base directories:**

    *   Create subdirectories within the `KNOWLEDGE_BASES_ROOT_DIR` for each knowledge base (e.g., `company`, `it_support`, `onboarding`).
    *   Place text files (e.g., `.txt`, `.md`) containing the knowledge base content within these subdirectories.

*   The server recursively reads all text files (e.g., `.txt`, `.md`) within the specified knowledge base subdirectories.
*   The server skips hidden files and directories (those starting with a `.`).
*   For each file, the server calculates the SHA256 hash and stores it in a file with the same name in a hidden `.index` subdirectory. This hash is used to determine if the file has been modified since the last indexing.
*   If the file is a Markdown file, it is split into chunks using the `MarkdownTextSplitter` from `langchain/text_splitter`.
*   The content of each file (or chunk, in the case of Markdown files) is then added to a FAISS index, which is used for similarity search.
*   The FAISS index is automatically initialized when the server starts. It checks for changes in the knowledge base files and updates the index accordingly.

## Usage

The server exposes two tools:

*   `list_knowledge_bases`: Lists the available knowledge bases.
*   `retrieve_knowledge`: Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 documents are returned with a score below a threshold of 2. A different threshold can optionally be provided using the `threshold` parameter.

You can use these tools through the MCP interface.

The `retrieve_knowledge` tool performs a semantic search using a FAISS index. The index is automatically updated when the server starts or when a file in a knowledge base is modified.

The output of the `retrieve_knowledge` tool is a markdown formatted string with the following structure:

```markdown
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
```

Each result includes the content of the most similar chunk, the source file, and a similarity score.
