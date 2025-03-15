#!/bin/bash

# Initialize Civic project
echo "Initializing Civic - Video Fact Checking Platform"
echo "================================================"

# Create directory structure
echo "Creating directory structure..."
mkdir -p civic-backend/app/api
mkdir -p civic-backend/app/services
mkdir -p civic-backend/app/models
mkdir -p civic-backend/app/utils
mkdir -p civic-backend/uploads

mkdir -p civic-frontend/public/assets/images
mkdir -p civic-frontend/src/components/layout
mkdir -p civic-frontend/src/components/video
mkdir -p civic-frontend/src/components/analysis
mkdir -p civic-frontend/src/components/search
mkdir -p civic-frontend/src/components/ui
mkdir -p civic-frontend/src/hooks
mkdir -p civic-frontend/src/pages
mkdir -p civic-frontend/src/services
mkdir -p civic-frontend/src/types
mkdir -p civic-frontend/src/utils

# Copy backend files
echo "Setting up backend..."
cp -r backend-files/* civic-backend/

# Copy frontend files
echo "Setting up frontend..."
cp -r frontend-files/* civic-frontend/

# Create .env files
echo "Creating environment files..."
cp civic-backend/.env.example civic-backend/.env

# Copy logo
echo "Adding logo..."
cp logo.svg civic-frontend/public/assets/images/

# Setting up Git
echo "Initializing Git repository..."
git init
cp project-gitignore .gitignore

# Copy Docker files
echo "Setting up Docker configuration..."
cp backend-dockerfile civic-backend/Dockerfile
cp frontend-dockerfile civic-frontend/Dockerfile
cp nginx-conf civic-frontend/nginx.conf
cp docker-compose.yml ./

# Install backend dependencies
echo "Installing backend dependencies..."
cd civic-backend
python -m pip install -r requirements.txt
cd ..

# Install frontend dependencies
echo "Installing frontend dependencies..."
cd civic-frontend
npm install
cd ..

echo "================================================"
echo "Setup complete! To start the application, run:"
echo "docker-compose up -d"
echo ""
echo "Or for development:"
echo "Backend: cd civic-backend && python run.py"
echo "Frontend: cd civic-frontend && npm start"
echo "================================================"
