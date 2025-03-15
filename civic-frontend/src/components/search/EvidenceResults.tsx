import React, { useState } from 'react';
import { FileSearch, ExternalLink, Calendar, User, ChevronsUpDown, Bookmark, Search } from 'lucide-react';
import { ClaimSearchResults } from '../../types';

interface EvidenceResultsProps {
  searchResults: ClaimSearchResults[];
  isSearching: boolean;
}

const EvidenceResults: React.FC<EvidenceResultsProps> = ({
  searchResults,
  isSearching
}) => {
  const [expandedClaims, setExpandedClaims] = useState<{ [claim: string]: boolean }>({});
  const [expandedKeywords, setExpandedKeywords] = useState<{ [keyword: string]: boolean }>({});
  
  const toggleClaimExpansion = (claim: string) => {
    setExpandedClaims(prev => ({
      ...prev,
      [claim]: !prev[claim]
    }));
  };
  
  const toggleKeywordExpansion = (keyword: string) => {
    setExpandedKeywords(prev => ({
      ...prev,
      [keyword]: !prev[keyword]
    }));
  };
  
  if (isSearching) {
    return (
      <div className="glass-panel p-6 min-h-[300px] flex flex-col items-center justify-center">
        <div className="animate-spin h-10 w-10 border-4 border-blue-600 border-t-transparent rounded-full mb-4"></div>
        <p className="text-gray-800 font-medium">Searching for evidence...</p>
        <p className="text-gray-600 text-sm mt-2">This may take a minute</p>
      </div>
    );
  }
  
  if (searchResults.length === 0) {
    return null;
  }

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center space-x-2 mb-6">
        <div className="p-1.5 bg-blue-100 rounded-md">
          <FileSearch className="h-5 w-5 text-blue-600" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900">Evidence Search Results</h2>
      </div>
      
      <div className="space-y-6">
        {searchResults.map((claimResults, claimIndex) => (
          <div key={claimIndex} className="bg-white p-4 border border-gray-200 rounded-lg shadow-sm">
            <button
              className="w-full flex items-center justify-between text-left"
              onClick={() => toggleClaimExpansion(claimResults.claim)}
            >
              <h3 className="text-lg font-medium text-gray-800">Claim: {claimResults.claim}</h3>
              <ChevronsUpDown className={`h-5 w-5 text-gray-500 transition-transform ${expandedClaims[claimResults.claim] ? 'rotate-180' : ''}`} />
            </button>
            
            {(expandedClaims[claimResults.claim] || claimIndex === 0) && (
              <div className="mt-4 space-y-4">
                {claimResults.keywordResults.map((keywordResult, keywordIndex) => (
                  <div key={keywordIndex} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between bg-gray-50 p-3 text-left border-b border-gray-200"
                      onClick={() => toggleKeywordExpansion(keywordResult.keyword)}
                    >
                      <div className="flex items-center space-x-2">
                        <Search className="h-4 w-4 text-blue-600" />
                        <h4 className="text-gray-700 font-medium">"{keywordResult.keyword}"</h4>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-sm text-gray-600 bg-white px-2 py-0.5 rounded-full border border-gray-200">
                          {keywordResult.results.length} results
                        </span>
                        <ChevronsUpDown className={`h-4 w-4 text-gray-500 transition-transform ${expandedKeywords[keywordResult.keyword] ? 'rotate-180' : ''}`} />
                      </div>
                    </button>
                    
                    {(expandedKeywords[keywordResult.keyword] || keywordIndex === 0) && (
                      <div className="p-3 space-y-3 max-h-[500px] overflow-y-auto">
                        {keywordResult.results.length > 0 ? (
                          keywordResult.results.map((result, resultIndex) => (
                            <div key={resultIndex} className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
                              <div className="flex justify-between items-start">
                                <h5 className="font-medium text-gray-800 text-base">{result.title}</h5>
                                <div className="flex items-center space-x-1 text-xs text-gray-500 bg-gray-50 px-2 py-0.5 rounded-full border border-gray-200">
                                  <span>Score:</span>
                                  <span className="font-mono">{result.score.toFixed(2)}</span>
                                </div>
                              </div>
                              
                              <p className="text-sm text-gray-700 mt-2 line-clamp-3">
                                {result.summary}
                              </p>
                              
                              <div className="flex flex-wrap items-center mt-3 text-xs text-gray-600 space-x-4">
                                {result.author && (
                                  <div className="flex items-center space-x-1">
                                    <User className="h-3 w-3" />
                                    <span>{result.author}</span>
                                  </div>
                                )}
                                
                                {result.publishedDate && (
                                  <div className="flex items-center space-x-1">
                                    <Calendar className="h-3 w-3" />
                                    <span>{new Date(result.publishedDate).toLocaleDateString()}</span>
                                  </div>
                                )}
                              </div>
                              
                              <div className="flex justify-between items-center mt-3">
                                <a 
                                  href={result.url} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-800 text-sm flex items-center"
                                >
                                  <span>View Source</span>
                                  <ExternalLink className="h-3 w-3 ml-1" />
                                </a>
                                
                                <button className="text-gray-500 hover:text-gray-700 flex items-center text-xs">
                                  <Bookmark className="h-3 w-3 mr-1" />
                                  <span>Save</span>
                                </button>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="text-center py-6 text-gray-500">
                            No results found for this search query.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default EvidenceResults;