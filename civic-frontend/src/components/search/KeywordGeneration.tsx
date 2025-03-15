import React from 'react';
import { Search, Key, ArrowRight } from 'lucide-react';
import { KeywordResult } from '../../types';

interface KeywordGenerationProps {
  keywordResults: KeywordResult[];
  onSearch: (claim: string, keywords: string[]) => void;
  isSearching: boolean;
}

const KeywordGeneration: React.FC<KeywordGenerationProps> = ({
  keywordResults,
  onSearch,
  isSearching
}) => {
  if (keywordResults.length === 0) return null;

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center space-x-2 mb-6">
        <Key className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-semibold text-white">Search Keywords</h2>
      </div>
      
      <div className="space-y-6">
        {keywordResults.map((result, index) => (
          <div key={index} className="glass-panel p-4">
            <h3 className="font-medium text-white text-base mb-3">Claim:</h3>
            <p className="text-white/90 text-sm mb-4 p-3 bg-white/5 rounded-lg border border-white/10">
              {result.claim}
            </p>
            
            <h4 className="font-medium text-white text-sm mb-2">Generated Search Queries:</h4>
            <ul className="space-y-2">
              {result.searchQueries.map((query, queryIndex) => (
                <li key={queryIndex} className="flex items-center">
                  <div className="p-2 flex-grow bg-white/5 rounded-l-md text-white/90 text-sm border border-white/10 border-r-0">
                    {query}
                  </div>
                  <button
                    className="p-2 bg-primary hover:bg-primary-600 text-white rounded-r-md transition-colors"
                    onClick={() => onSearch(result.claim, [query])}
                    disabled={isSearching}
                  >
                    {isSearching ? (
                      <div className="animate-spin h-4 w-4 border-2 border-white border-opacity-50 border-t-white rounded-full"></div>
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            
            <button
              className="mt-4 w-full flex items-center justify-center space-x-2 p-2 bg-primary/20 hover:bg-primary/30 text-primary font-medium rounded-md transition-colors border border-primary/30"
              onClick={() => onSearch(result.claim, result.searchQueries)}
              disabled={isSearching}
            >
              <span>Search All Keywords</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KeywordGeneration;