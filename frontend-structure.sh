civic-frontend/
├── public/
│   ├── index.html
│   ├── favicon.ico
│   └── assets/
│       └── images/
│           ├── logo.svg
│           └── og-image.png
├── src/
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Header.tsx
│   │   │   ├── Footer.tsx
│   │   │   └── Layout.tsx
│   │   ├── video/
│   │   │   ├── VideoInput.tsx
│   │   │   ├── VideoThumbnail.tsx
│   │   │   └── TranscriptDisplay.tsx
│   │   ├── analysis/
│   │   │   ├── ClaimCard.tsx
│   │   │   ├── AnalysisResults.tsx
│   │   │   ├── ModelComparison.tsx
│   │   │   ├── FactCheckCard.tsx
│   │   │   └── Summary.tsx
│   │   ├── search/
│   │   │   ├── KeywordGeneration.tsx
│   │   │   └── EvidenceResults.tsx
│   │   └── ui/
│   │       ├── Button.tsx
│   │       ├── Card.tsx
│   │       ├── Input.tsx
│   │       ├── Tabs.tsx
│   │       ├── StatusBadge.tsx
│   │       └── Loading.tsx
│   ├── pages/
│   │   ├── HomePage.tsx
│   │   └── AnalysisPage.tsx
│   ├── services/
│   │   └── api.ts
│   ├── hooks/
│   │   ├── useVideoAnalysis.ts
│   │   └── useEvidenceSearch.ts
│   ├── types/
│   │   └── index.ts
│   ├── utils/
│   │   └── helpers.ts
│   ├── App.tsx
│   ├── index.tsx
│   └── index.css
├── package.json
├── tsconfig.json
└── tailwind.config.js
