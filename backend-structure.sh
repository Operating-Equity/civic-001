civic-backend/
├── app/
│   ├── __init__.py           # Flask application factory
│   ├── config.py             # Configuration settings
│   ├── api/                  # API endpoints
│   │   ├── __init__.py
│   │   ├── routes.py
│   │   ├── video_routes.py
│   │   ├── analysis_routes.py
│   │   └── search_routes.py
│   ├── services/             # Core business logic
│   │   ├── __init__.py
│   │   ├── video_service.py
│   │   ├── transcript_service.py
│   │   ├── openai_service.py
│   │   ├── anthropic_service.py
│   │   ├── perplexity_service.py
│   │   ├── search_service.py
│   │   └── claim_analysis.py
│   ├── models/               # Data models and schemas
│   │   ├── __init__.py
│   │   └── schemas.py
│   └── utils/                # Helper utilities
│       ├── __init__.py
│       └── helpers.py
├── requirements.txt
├── run.py                    # Application entrypoint
└── .env.example              # Environment variables template
