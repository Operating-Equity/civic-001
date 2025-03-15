import React from 'react';
import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';

const Header = () => {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-lg bg-background-dark/80 border-b border-white/5">
      <div className="container mx-auto px-4 h-16 flex justify-between items-center">
        <Link to="/" className="flex items-center space-x-2 group">
          <div className="bg-primary/10 p-1.5 rounded-md transition-colors group-hover:bg-primary/20">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <span className="text-lg font-semibold text-white tracking-tight">Civic</span>
        </Link>
        
        <nav className="hidden md:flex items-center space-x-8">
          <Link to="/" className="text-white/80 hover:text-white transition-colors text-sm font-medium">
            Home
          </Link>
          <a href="#verification" className="text-white/80 hover:text-white transition-colors text-sm font-medium">
            Verification
          </a>
          <a href="#about" className="text-white/80 hover:text-white transition-colors text-sm font-medium">
            About
          </a>
        </nav>
        
        <div className="flex items-center space-x-4">
          <button className="hidden md:inline-flex bg-primary hover:bg-primary-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm">
            Get Started
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;