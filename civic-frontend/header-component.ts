import React from 'react';
import { Link } from 'react-router-dom';
import { Search, Shield } from 'lucide-react';

const Header = () => {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-lg bg-background-dark/80 border-b border-white/10">
      <div className="container mx-auto px-4 py-3 flex justify-between items-center">
        <Link to="/" className="flex items-center space-x-2">
          <Shield className="h-8 w-8 text-primary" />
          <span className="text-xl font-bold text-white tracking-tight">Civic</span>
        </Link>
        
        <nav className="hidden md:flex items-center space-x-6">
          <Link to="/" className="text-white/80 hover:text-white transition-colors">
            Home
          </Link>
          <a href="#features" className="text-white/80 hover:text-white transition-colors">
            Features
          </a>
          <a href="#how-it-works" className="text-white/80 hover:text-white transition-colors">
            How It Works
          </a>
          <a href="https://github.com/civic-ai/civic" className="text-white/80 hover:text-white transition-colors">
            GitHub
          </a>
        </nav>
        
        <div className="flex items-center space-x-4">
          <button className="p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-full transition-colors">
            <Search className="h-5 w-5" />
          </button>
          <button className="hidden md:inline-flex bg-primary hover:bg-primary-600 text-white px-4 py-2 rounded-lg transition-colors">
            Get Started
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
