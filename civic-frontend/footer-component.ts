import React from 'react';
import { Link } from 'react-router-dom';
import { Shield, Github, Twitter, Linkedin } from 'lucide-react';

const Footer = () => {
  const currentYear = new Date().getFullYear();
  
  return (
    <footer className="bg-background-dark/80 border-t border-white/10 py-8">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="space-y-4">
            <div className="flex items-center space-x-2">
              <Shield className="h-6 w-6 text-primary" />
              <span className="text-lg font-bold text-white">Civic</span>
            </div>
            <p className="text-white/70 text-sm">
              An advanced video fact-checking platform powered by AI to help verify claims and combat misinformation.
            </p>
            <div className="flex space-x-4">
              <a href="#" className="text-white/50 hover:text-white/90 transition-colors">
                <Github className="h-5 w-5" />
              </a>
              <a href="#" className="text-white/50 hover:text-white/90 transition-colors">
                <Twitter className="h-5 w-5" />
              </a>
              <a href="#" className="text-white/50 hover:text-white/90 transition-colors">
                <Linkedin className="h-5 w-5" />
              </a>
            </div>
          </div>
          
          <div>
            <h3 className="text-white font-medium mb-4">Resources</h3>
            <ul className="space-y-2 text-white/70">
              <li><a href="#" className="hover:text-white/90 transition-colors">Documentation</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">API Reference</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Fact-Checking Guidelines</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Blog</a></li>
            </ul>
          </div>
          
          <div>
            <h3 className="text-white font-medium mb-4">Company</h3>
            <ul className="space-y-2 text-white/70">
              <li><a href="#" className="hover:text-white/90 transition-colors">About Us</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Careers</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Press</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Contact</a></li>
            </ul>
          </div>
          
          <div>
            <h3 className="text-white font-medium mb-4">Legal</h3>
            <ul className="space-y-2 text-white/70">
              <li><a href="#" className="hover:text-white/90 transition-colors">Privacy Policy</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Terms of Service</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Ethics Policy</a></li>
              <li><a href="#" className="hover:text-white/90 transition-colors">Copyright</a></li>
            </ul>
          </div>
        </div>
        
        <div className="mt-12 pt-6 border-t border-white/10 flex flex-col md:flex-row justify-between items-center text-sm text-white/50">
          <div>&copy; {currentYear} Civic AI. All rights reserved.</div>
          <div className="mt-4 md:mt-0">
            Made with transparency and accountability in mind.
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
