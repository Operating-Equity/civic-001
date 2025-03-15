import React from 'react';
import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';

const Header = () => {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-lg bg-white/80 border-b border-gray-200">
      <div className="container mx-auto px-4 h-16 flex justify-between items-center">
        <Link to="/" className="flex items-center space-x-2 group">
          <div className="bg-blue-100 p-1.5 rounded-md transition-colors group-hover:bg-blue-200">
            <Shield className="h-6 w-6 text-blue-600" />
          </div>
          <span className="text-lg font-semibold text-gray-900">Civic</span>
        </Link>
        
        <nav className="flex items-center space-x-8">
          <Link to="/" className="text-gray-700 hover:text-blue-600 transition-colors text-sm font-medium">
            Home
          </Link>
          <Link to="/verification" className="text-gray-700 hover:text-blue-600 transition-colors text-sm font-medium">
            Verification
          </Link>
          <Link to="/about" className="text-gray-700 hover:text-blue-600 transition-colors text-sm font-medium">
            About
          </Link>
          
          <button className="inline-flex bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm">
            Get Started
          </button>
        </nav>
      </div>
    </header>
  );
};

export default Header;