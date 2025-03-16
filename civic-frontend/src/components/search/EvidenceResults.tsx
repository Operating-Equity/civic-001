import React, { useState, useEffect } from 'react';
import { FileSearch, ExternalLink, Calendar, User, ChevronDown, ChevronUp, Bookmark, Search, AlertCircle, Clock, ShieldCheck, AlertTriangle, Link2, Filter, HelpCircle } from 'lucide-react';

const EvidenceResults = ({ searchResults, isSearching }) => {
  const [expandedClaims, setExpandedClaims] = useState({});
  const [expandedKeywords, setExpandedKeywords] = useState({});
  const [filterHighCredibility, setFilterHighCredibility] = useState(false);
  const [sortMethod, setSortMethod] = useState('relevance'); // 'relevance', 'date', 'credibility'
  const [showFilters, setShowFilters] = useState(false);
  
  const toggleClaimExpansion = (claim) => {
    setExpandedClaims(prev => ({
      ...prev,
      [claim]: !prev[claim]
    }));
  };
  
  const toggleKeywordExpansion = (keyword) => {
    setExpandedKeywords(prev => ({
      ...prev,
      [keyword]: !prev[keyword]
    }));
  };
  
  // Function to determine if a source is high credibility
  const isHighCredibilitySource = (result) => {
    if (!result) return false;
    
    // If we have a credibility score, use it
    if (result.credibilityScore !== undefined) {
      return result.credibilityScore >= 0.8;
    }
    
    // Otherwise check the domain
    const url = result.url || '';
    return url.includes('.gov') || 
           url.includes('.edu') || 
           url.includes('reuters.com') || 
           url.includes('apnews.com') ||
           url.includes('nature.com') ||
           url.includes('science.org') ||
           url.includes('nih.gov');
  };
  
  // Format date in a user-friendly way
  const formatDate = (dateString) => {
    if (!dateString) return 'Unknown date';
    
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
      });
    } catch (e) {
      return dateString;
    }
  };
  
  // Get sorted and filtered results for a keyword
  const getSortedFilteredResults = (results) => {
    if (!results || results.length === 0) return [];
    
    // Apply high credibility filter if enabled
    let filteredResults = results;
    if (filterHighCredibility) {
      filteredResults = results.filter(isHighCredibilitySource);
      
      // If no high credibility sources, return original results with a note
      if (filteredResults.length === 0) {
        return results;
      }
    }
    
    // Apply sorting
    return [...filteredResults].sort((a, b) => {
      if (sortMethod === 'date') {
        // Sort by date (newest first)
        const dateA = a.publishedDate ? new Date(a.publishedDate) : new Date(0);
        const dateB = b.publishedDate ? new Date(b.publishedDate) : new Date(0);
        return dateB - dateA;
      } else if (sortMethod === 'credibility') {
        // Sort by credibility score
        const credA = a.credibilityScore || 0;
        const credB = b.credibilityScore || 0;
        return credB - credA;
      } else {
        // Default: sort by relevance (score)
        return (b.score || 0) - (a.score || 0);
      }
    });
  };
  
  // Count total results across all claims and keywords
  const totalResults = searchResults.reduce((total, claim) => {
    return total + claim.keywordResults.reduce((keywordTotal, keyword) => {
      return keywordTotal + keyword.results.length;
    }, 0);
  }, 0);
  
  // Check if we have any results at all
  const hasAnyResults = totalResults > 0;
  
  // Calculate how many claims have time-bound indicators
  const timeboundClaimCount = searchResults.filter(claim => 
    claim.keywordResults && 
    claim.keywordResults.some(kw => kw.keyword === "Current information (real-time search)")
  ).length;

  if (isSearching) {
    return (
      <div className="glass-panel p-6 min-h-[300px] flex flex-col items-center justify-center">
        <div className="animate-spin h-10 w-10 border-4 border-blue-600 border-t-transparent rounded-full mb-4"></div>
        <p className="text-gray-800 font-medium">Searching for evidence...</p>
        <p className="text-gray-600 text-sm mt-2">Checking multiple sources for verification</p>
      </div>
    );
  }
  
  if (searchResults.length === 0) {
    return null;
  }

  return (
    <div className="glass-panel p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-blue-100 rounded-md">
            <FileSearch className="h-5 w-5 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900">Evidence Search Results</h2>
        </div>
        
        {/* Filters and sorting tools */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center space-x-1.5 text-sm text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          <Filter className="h-4 w-4" />
          <span>Filters & Sorting</span>
          {showFilters ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
      
      {/* Search stats */}
      <div className="mb-6 bg-gray-50 rounded-lg p-3 border border-gray-200 flex flex-wrap gap-4 items-center">
        <div className="flex items-center">
          <Search className="h-4 w-4 text-gray-500 mr-2" />
          <span className="text-sm text-gray-700">
            <span className="font-medium">{totalResults}</span> results across 
            <span className="font-medium"> {searchResults.length}</span> claims
          </span>
        </div>
        
        {timeboundClaimCount > 0 && (
          <div className="flex items-center">
            <Clock className="h-4 w-4 text-blue-600 mr-2" />
            <span className="text-sm text-gray-700">
              <span className="font-medium">{timeboundClaimCount}</span> time-sensitive claims
            </span>
          </div>
        )}
      </div>
      
      {/* Filters Panel */}
      {showFilters && (
        <div className="mb-6 bg-blue-50 p-4 rounded-lg border border-blue-100">
          <div className="flex flex-wrap gap-6">
            <div>
              <h3 className="text-sm font-medium text-gray-800 mb-2 flex items-center">
                <Filter className="h-4 w-4 mr-1.5 text-blue-600" />
                Filter Sources
              </h3>
              <div className="flex items-center space-x-1 text-sm">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={filterHighCredibility}
                    onChange={() => setFilterHighCredibility(!filterHighCredibility)}
                    className="rounded text-blue-600 focus:ring-blue-500"
                  />
                  <span className="flex items-center">
                    <ShieldCheck className="h-3.5 w-3.5 text-blue-600 mr-1" />
                    High-credibility sources only
                  </span>
                </label>
                <button className="text-gray-400 hover:text-gray-600">
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            
            <div>
              <h3 className="text-sm font-medium text-gray-800 mb-2 flex items-center">
                <ArrowsUpDown className="h-4 w-4 mr-1.5 text-blue-600" />
                Sort Results By
              </h3>
              <div className="flex gap-3 text-sm">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="radio" 
                    checked={sortMethod === 'relevance'}
                    onChange={() => setSortMethod('relevance')}
                    name="sort-method"
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span>Relevance</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="radio" 
                    checked={sortMethod === 'date'}
                    onChange={() => setSortMethod('date')}
                    name="sort-method"
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span>Date (newest)</span>
                </label>
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="radio" 
                    checked={sortMethod === 'credibility'}
                    onChange={() => setSortMethod('credibility')}
                    name="sort-method"
                    className="text-blue-600 focus:ring-blue-500"
                  />
                  <span>Credibility</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {!hasAnyResults && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 mb-6">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-amber-500 mt-0.5 mr-3 flex-shrink-0" />
            <div>
              <h3 className="font-medium text-amber-800 mb-1">No evidence found</h3>
              <p className="text-amber-700 text-sm">
                Our search couldn't find supporting evidence for these claims. This could be because:
              </p>
              <ul className="mt-2 text-sm text-amber-700 list-disc pl-5 space-y-1">
                <li>The search terms may need to be refined for better results</li>
                <li>The claim may be about a very recent event not yet widely documented</li>
                <li>The claim may be too specific or niche for general search engines</li>
                <li>There may be a temporary issue with our search provider</li>
              </ul>
              <p className="mt-3 text-sm text-amber-700">
                Try manually searching for this information or adjusting your search terms.
              </p>
            </div>
          </div>
        </div>
      )}
      
      <div className="space-y-6">
        {searchResults.map((claimResults, claimIndex) => (
          <div key={claimIndex} className="bg-white p-4 border border-gray-200 rounded-lg shadow-sm">
            <button
              className="w-full flex items-center justify-between text-left"
              onClick={() => toggleClaimExpansion(claimResults.claim)}
            >
              <h3 className="text-lg font-medium text-gray-800">Claim: {claimResults.claim}</h3>
              <ChevronDown className={`h-5 w-5 text-gray-500 transition-transform ${expandedClaims[claimResults.claim] ? 'rotate-180' : ''}`} />
            </button>
            
            {(expandedClaims[claimResults.claim] || claimIndex === 0) && (
              <div className="mt-4 space-y-4">
                {claimResults.keywordResults.map((keywordResult, keywordIndex) => {
                  // Get filtered results
                  const filteredResults = getSortedFilteredResults(keywordResult.results);
                  
                  // Check if this is a timebound result
                  const isTimebound = keywordResult.keyword === "Current information (real-time search)";
                  
                  return (
                    <div key={keywordIndex} className="border border-gray-200 rounded-lg overflow-hidden">
                      <button
                        className={`w-full flex items-center justify-between text-left p-3 border-b border-gray-200 ${
                          isTimebound ? 'bg-blue-50' : 'bg-gray-50'
                        }`}
                        onClick={() => toggleKeywordExpansion(keywordResult.keyword)}
                      >
                        <div className="flex items-center space-x-2">
                          {isTimebound ? (
                            <Clock className="h-4 w-4 text-blue-600" />
                          ) : (
                            <Search className="h-4 w-4 text-blue-600" />
                          )}
                          <h4 className="text-gray-700 font-medium">
                            "{keywordResult.keyword}"
                          </h4>
                          
                          {/* Label for timebound results */}
                          {isTimebound && (
                            <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full">
                              Real-time search
                            </span>
                          )}
                        </div>
                        <div className="flex items-center space-x-2">
                          <span className={`text-sm ${
                            isTimebound ? 'bg-blue-100 text-blue-800' : 'bg-white text-gray-600'
                          } px-2 py-0.5 rounded-full border ${
                            isTimebound ? 'border-blue-200' : 'border-gray-200'
                          }`}>
                            {keywordResult.results.length} results
                          </span>
                          <ChevronDown className={`h-4 w-4 text-gray-500 transition-transform ${expandedKeywords[keywordResult.keyword] ? 'rotate-180' : ''}`} />
                        </div>
                      </button>
                      
                      {(expandedKeywords[keywordResult.keyword] || keywordIndex === 0) && (
                        <div className="p-3 space-y-3 max-h-[500px] overflow-y-auto">
                          {/* Filter indicator when high credibility filter is on */}
                          {filterHighCredibility && filteredResults.length > 0 && (
                            <div className="flex items-center px-3 py-2 bg-blue-50 text-blue-700 text-sm rounded-lg border border-blue-100">
                              <ShieldCheck className="h-4 w-4 mr-2 text-blue-600" />
                              <span>Showing high-credibility sources only</span>
                            </div>
                          )}
                          
                          {/* Show when high credibility filter is on but no results match */}
                          {filterHighCredibility && filteredResults.length === 0 && keywordResult.results.length > 0 && (
                            <div className="flex items-center px-3 py-2 bg-amber-50 text-amber-700 text-sm rounded-lg border border-amber-100">
                              <AlertTriangle className="h-4 w-4 mr-2 text-amber-600" />
                              <span>No high-credibility sources found. Showing all results.</span>
                            </div>
                          )}
                          
                          {keywordResult.results.length > 0 ? (
                            filteredResults.map((result, resultIndex) => (
                              <div key={resultIndex} className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
                                <div className="flex justify-between items-start">
                                  <div className="flex-1">
                                    <h5 className="font-medium text-gray-800 text-base">{result.title}</h5>
                                    
                                    {/* Domain display with credibility indicator */}
                                    {result.domain && (
                                      <div className="flex items-center mt-1">
                                        <div className="flex items-center mr-2">
                                          <Link2 className="h-3 w-3 text-gray-500 mr-1" />
                                          <span className="text-xs text-gray-600">{result.domain}</span>
                                        </div>
                                        
                                        {/* Credibility indicator */}
                                        {isHighCredibilitySource(result) && (
                                          <div className="flex items-center bg-green-50 px-1.5 py-0.5 rounded text-xs text-green-700 border border-green-100">
                                            <ShieldCheck className="h-3 w-3 mr-0.5" />
                                            <span>High credibility</span>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  
                                  <div className="flex items-center space-x-1 text-xs text-gray-500 bg-gray-50 px-2 py-0.5 rounded-full border border-gray-200 ml-2">
                                    <span>Match:</span>
                                    <span className="font-mono">{Math.round(result.score * 100)}%</span>
                                  </div>
                                </div>
                                
                                <p className="text-sm text-gray-700 mt-2 line-clamp-3">
                                  {result.summary || result.text?.substring(0, 150)}
                                </p>
                                
                                {/* Highlights section */}
                                {result.highlights && result.highlights.length > 0 && (
                                  <div className="mt-2 p-2 bg-yellow-50 rounded-md border border-yellow-100">
                                    <p className="text-xs text-gray-700 italic">
                                      "{result.highlights[0]}"
                                    </p>
                                  </div>
                                )}
                                
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
                                      <span>{formatDate(result.publishedDate)}</span>
                                    </div>
                                  )}
                                  
                                  {/* Label for real-time results */}
                                  {result.isLiveCrawl && (
                                    <div className="flex items-center px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded border border-blue-100">
                                      <Clock className="h-3 w-3 mr-1" />
                                      <span>Real-time data</span>
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
                              <AlertCircle className="h-5 w-5 mx-auto mb-2 text-gray-400" />
                              <p>No results found for this search query.</p>
                              <p className="text-xs mt-1">Try adjusting the search terms for better results.</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// Helper component for sorting arrow
const ArrowsUpDown = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </svg>
);

export default EvidenceResults;