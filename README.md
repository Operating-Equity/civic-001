# CIVIC

> **Current work: the main page prototype lives in [`civic-web/`](civic-web/README.md).**
> Paste or upload text, CIVIC extracts every empirical claim, tests the first 20 in parallel, and
> shows each determination with its full entry, a live True / False / Unverified count, a challenge
> panel per result, and a reset. The prompts are held server-side and never reach the browser.
> Run it with `cd civic-web && npm install && npm start` (see its README for the prompt vault).
>
> Everything below describes the earlier video-analysis prototype (`civic-backend/`, `civic-frontend/`),
> kept in place for reference.

---

# Civic - Advanced Video Fact Checking Platform

![Civic Logo](civic-frontend/public/assets/images/logo.svg)

Civic is an advanced video fact-checking platform that uses AI to analyze videos, extract empirical claims, and verify facts using multiple AI models and evidence search.

## Features

- **Video Analysis**: Extract and analyze transcripts from YouTube videos or uploaded files
- **Multi-Model Fact-Checking**: Cross-reference claims across multiple AI models (OpenAI, Anthropic, Perplexity)
- **Evidence Search**: Automatically search for supporting evidence from reputable sources
- **Claim Verification**: Evaluate empirical claims for accuracy, context, and supporting evidence

## Architecture

Civic consists of two main components:

1. **Backend API (Flask)**: Handles video processing, transcript extraction, AI-powered analysis, and evidence search
2. **Frontend UI (React)**: Provides a modern, intuitive interface for uploading videos and reviewing analysis results

## Prerequisites

- [Docker](https://www.docker.com/get-started)
- [Docker Compose](https://docs.docker.com/compose/install/)
- API keys for:
  - OpenAI
  - Anthropic
  - Perplexity
  - AssemblyAI (for video transcription)
  - Exa.ai (for evidence search)

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/your-username/civic.git
cd civic
```

### 2. Configure environment variables

Create a `.env` file in the `civic-backend` directory:

```bash
# Base configuration
FLASK_APP=run.py
FLASK_DEBUG=0
SECRET_KEY=your-secure-secret-key

# API Keys
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
PERPLEXITY_API_KEY=your-perplexity-key
EXA_API_KEY=your-exa-api-key
ASSEMBLY_AI_KEY=your-assemblyai-key
RAPIDAPI_KEY=your-rapidapi-key
```

### 3. Start the application with Docker Compose

```bash
docker-compose up -d
```

This will:
- Build and start the backend API service
- Build and start the frontend web service
- Configure networking between the services
- Expose the application on port 80

### 4. Access the application

Open your browser and navigate to `http://localhost`

## Development Setup

If you want to develop Civic locally without Docker:

### Backend

```bash
cd civic-backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
flask run
```

### Frontend

```bash
cd civic-frontend
npm install
npm start
```

The frontend will be available at `http://localhost:3000` and will proxy API requests to the backend at `http://localhost:5000`.

## API Documentation

### Video Processing

- `POST /api/video/process`
  - Process a video from YouTube URL or file upload
  - Returns transcript, claims, and summary

### Analysis

- `POST /api/analysis/claims`
  - Extract empirical claims from transcript
- `POST /api/analysis/summary`
  - Generate a summary from transcript
- `POST /api/analysis/evaluate`
  - Evaluate a claim across multiple AI models

### Search

- `POST /api/search/keywords`
  - Generate search keywords for a claim
- `POST /api/search/evidence`
  - Search for evidence related to keywords

## Technologies Used

### Backend
- Flask (Python web framework)
- AssemblyAI (video transcription)
- OpenAI GPT-4 (claim extraction and evaluation)
- Anthropic Claude (claim evaluation)
- Perplexity API (claim evaluation with web search)
- Exa.ai (evidence search)

### Frontend
- React (UI library)
- TypeScript (type safety)
- Tailwind CSS (styling)
- Lucide React (icons)
- Axios (API communication)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgements

- [OpenAI](https://openai.com) for GPT models
- [Anthropic](https://anthropic.com) for Claude models
- [Perplexity](https://perplexity.ai) for search-powered responses
- [AssemblyAI](https://assemblyai.com) for audio transcription
- [Exa.ai](https://exa.ai) for evidence search capabilities
