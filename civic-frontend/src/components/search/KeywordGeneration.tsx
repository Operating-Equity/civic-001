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
        <div className="p-1.5 bg-blue-100 rounded-md">
          <Key className="h-5 w-5 text-blue-600" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900">Search Keywords</h2>
      </div>
      
      <div className="space-y-6">
        {keywordResults.map((result, index) => (
          <div key={index} className="bg-white p-5 border border-gray-200 rounded-lg shadow-sm">
            <h3 className="font-medium text-gray-800 text-base mb-3">Claim:</h3>
            <p className="text-gray-700 text-sm mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              {result.claim}
            </p>
            
            <h4 className="font-medium text-gray-800 text-sm mb-2">Generated Search Queries:</h4>
            <ul className="space-y-2">
              {result.searchQueries.map((query, queryIndex) => (
                <li key={queryIndex} className="flex items-center">
                  <div className="p-2 flex-grow bg-gray-50 rounded-l-md text-gray-700 text-sm border border-gray-200 border-r-0">
                    {query}
                  </div>
                  <button
                    className="p-2 bg-blue-600 hover:bg-blue-700 text-white rounded-r-md transition-colors"
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
              className="mt-4 w-full flex items-center justify-center space-x-2 p-2 bg-blue-100 hover:bg-blue-200 text-blue-700 font-medium rounded-md transition-colors border border-blue-200"
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