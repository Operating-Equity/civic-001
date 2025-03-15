import React, { useState, useEffect, useRef } from 'react';
import { Shield, CheckCircle, Search, ArrowRight, Award, FileSearch, Users, Monitor, BarChart, Settings, Info } from 'lucide-react';
import VideoInput from '../components/video/VideoInput';
import VideoThumbnail from '../components/video/VideoThumbnail';
import TranscriptDisplay from '../components/video/TranscriptDisplay';
import Summary from '../components/analysis/Summary';
import ClaimEvaluator from '../components/analysis/ClaimEvaluator';
import KeywordGeneration from '../components/search/KeywordGeneration';
import EvidenceResults from '../components/search/EvidenceResults';
import SpeakerIdentification from '../components/analysis/SpeakerIdentification';
import VerificationCertificate from '../components/analysis/VerificationCertificate';
import { useVideoAnalysis } from '../hooks/useVideoAnalysis';
import { useEvidenceSearch } from '../hooks/useEvidenceSearch';

const HomePage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'analysis' | 'evidence' | 'dashboard' | 'certificate'>('dashboard');
  const resultsRef = useRef<HTMLDivElement>(null);
  
  const {
    transcript,
    thumbnailUrl,
    summary,
    videoTitle,
    empiricalClaims,
    perplexityResults,
    openAIResults,
    anthropicResults,
    speakersData,
    isLoading,
    error,
    processingClaimIndex,
    processingStage,
    serviceStatus,
    handleVideoSubmit
  } = useVideoAnalysis();
  
  const {
    keywordResults,
    searchResults,
    isSearching,
    searchForEvidence,
    searchAllClaims
  } = useEvidenceSearch(empiricalClaims, videoTitle);
  
  const hasResults = transcript && !isLoading;

  // Scroll to results when they become available
  useEffect(() => {
    if (hasResults && resultsRef.current) {
      // Wait for DOM to update before scrolling
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [hasResults]);

  // Calculate result statistics for dashboard
  const calculateStats = () => {
    // Count claim classifications
    const allResults = [...perplexityResults, ...openAIResults, ...anthropicResults];
    
    const counts = {
      TRUE: 0,
      FALSE: 0,
      UNVERIFIED: 0
    };
    
    allResults.forEach(result => {
      if (result.classification in counts) {
        counts[result.classification]++;
      }
    });
    
    // Calculate average confidence
    const totalConfidence = allResults.reduce((sum, result) => sum + result.confidence, 0);
    const avgConfidence = allResults.length > 0 ? Math.round(totalConfidence / allResults.length) : 0;
    
    return {
      counts,
      avgConfidence,
      totalClaims: empiricalClaims.length,
      speakerCount: speakersData ? Object.keys(speakersData.speakers).length : 0
    };
  };
  
  const stats = calculateStats();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation Bar */}
      <div className="bg-white py-4 px-6 shadow-sm sticky top-0 z-20">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-2 group">
            <div className="p-2 bg-blue-100 rounded-md">
              <Shield className="h-5 w-5 text-blue-600" />
            </div>
            <span className="text-lg font-semibold text-gray-900">Civic</span>
            <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">Content Creator Studio</span>
          </div>
          
          {hasResults && (
            <div className="flex space-x-4">
              <button 
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                  ${activeSection === 'dashboard' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
                onClick={() => setActiveSection('dashboard')}
              >
                <Monitor className="h-4 w-4" />
                <span>Dashboard</span>
              </button>
              <button 
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                  ${activeSection === 'analysis' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
                onClick={() => setActiveSection('analysis')}
              >
                <CheckCircle className="h-4 w-4" />
                <span>Verification</span>
              </button>
              <button 
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                  ${activeSection === 'evidence' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
                onClick={() => setActiveSection('evidence')}
              >
                <Search className="h-4 w-4" />
                <span>Evidence</span>
              </button>
              <button 
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                  ${activeSection === 'certificate' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}
                onClick={() => setActiveSection('certificate')}
              >
                <Award className="h-4 w-4" />
                <span>Certificate</span>
              </button>
            </div>
          )}
        </div>
      </div>
    
      {/* Hero Section */}
      {!hasResults && (
        <section className="relative py-16 bg-white">
          <div className="container mx-auto px-4 relative z-10">
            <div className="text-center max-w-2xl mx-auto mb-8">
              <div className="flex justify-center mb-6">
                <div className="p-3 bg-blue-100 rounded-full">
                  <Shield className="h-12 w-12 text-blue-600" />
                </div>
              </div>
              
              <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4 tracking-tight">
                Content Creator Verification Studio
              </h1>
              
              <p className="text-lg text-gray-700 mb-6">
                Enhance your credibility with AI-powered multi-model verification. Identify speakers, verify claims, and generate evidence-backed reports for your audience.
              </p>
            </div>
          </div>
        </section>
      )}
      
      {/* Video Analysis Section */}
      <section id="analysis" className={`py-8 ${hasResults ? 'bg-gray-50' : 'bg-white'}`}>
        <div className="container mx-auto px-4">
          <div className={`mx-auto ${hasResults ? 'max-w-6xl' : 'max-w-3xl'}`}>
            {!hasResults && (
              <div className="mb-8 text-center">
                <h2 className="text-2xl font-bold text-gray-900">
                  Verify a Video
                </h2>
                <p className="text-gray-700 mt-2">
                  Enter a YouTube URL or upload a video to start the verification process
                </p>
              </div>
            )}
            
            {!hasResults && (
              <VideoInput 
                onVideoSubmit={handleVideoSubmit} 
                isProcessing={isLoading} 
                error={error}
                processingStage={processingStage}
              />
            )}
            
            {/* Enhanced Loading Indicator */}
            {isLoading && (
                <div className="mt-8 bg-white p-8 rounded-lg border border-gray-200 shadow-sm">
                    <div className="flex justify-center mb-6">
                    <div className="h-16 w-16 rounded-full border-4 border-blue-600 border-t-transparent animate-spin"></div>
                    </div>
                    <h3 className="text-xl font-medium text-gray-800 text-center mb-3">Processing Your Video</h3>
                    
                    {/* Dynamic subtitle based on processing stage */}
                    <p className="text-gray-700 text-center mb-8">
                    {processingStage === 'extracting_transcript' && "Extracting transcript from your video..."}
                    {processingStage === 'identifying_speakers' && "Identifying speakers in your video..."}
                    {processingStage === 'extracting_claims' && "Identifying empirical claims in your content..."}
                    {processingStage === 'verifying_claims' && "Verifying claims with multiple AI models..."}
                    </p>
                    
                    {/* Only show the VideoInput progress bars when not in claim verification */}
                    {processingStage !== 'verifying_claims' ? (
                    <VideoInput 
                        onVideoSubmit={handleVideoSubmit} 
                        isProcessing={isLoading} 
                        error={error}
                        processingStage={processingStage}
                        totalClaims={empiricalClaims.length}
                        currentClaimIndex={processingClaimIndex}
                    />
                    ) : (
                    /* When verifying claims, show the ClaimEvaluator progress instead */
                    <div className="max-w-3xl mx-auto">
                        <ClaimEvaluator 
                        empiricalClaims={empiricalClaims}
                        perplexityResults={perplexityResults}
                        openAIResults={openAIResults}
                        anthropicResults={anthropicResults}
                        speakersData={speakersData}
                        videoTitle={videoTitle}
                        thumbnailUrl={thumbnailUrl}
                        processingClaimIndex={processingClaimIndex}
                        />
                    </div>
                    )}
                </div>
                )}
          </div>
        </div>
      </section>
      
      {/* Trust Indicators */}
      {!hasResults && !isLoading && (
        <section className="py-12 bg-gray-50">
          <div className="container mx-auto px-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 max-w-4xl mx-auto">
              <div className="flex flex-col items-center text-center px-4 py-6 bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                  <CheckCircle className="h-6 w-6 text-blue-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Multi-Model Verification</h3>
                <p className="text-gray-700 text-sm">Cross-checking claims using OpenAI, Anthropic, and Perplexity for balanced analysis</p>
              </div>
              
              <div className="flex flex-col items-center text-center px-4 py-6 bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                  <Search className="h-6 w-6 text-blue-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Evidence-Based Results</h3>
                <p className="text-gray-700 text-sm">Automatic search for supporting sources to back every verification decision</p>
              </div>
              
              <div className="flex flex-col items-center text-center px-4 py-6 bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                  <Users className="h-6 w-6 text-blue-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Speaker Identification</h3>
                <p className="text-gray-700 text-sm">Accurately attribute each claim to specific speakers in your content</p>
              </div>
              
              <div className="flex flex-col items-center text-center px-4 py-6 bg-white rounded-lg shadow-sm border border-gray-200">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                  <Award className="h-6 w-6 text-blue-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Verification Certificate</h3>
                <p className="text-gray-700 text-sm">Shareable verification certificates with transparent analysis for your audience</p>
              </div>
            </div>
          </div>
        </section>
      )}
      
      {/* Results Section (conditionally rendered) */}
      {hasResults && (
        <section className="py-6 bg-gray-50" ref={resultsRef}>
          <div className="container mx-auto px-4">
            <div className="max-w-6xl mx-auto">
              {activeSection === 'dashboard' && (
                <>
                  {/* Dashboard View */}
                  <div className="mb-8">
                    <h2 className="text-2xl font-bold text-gray-900 mb-6">Verification Dashboard</h2>
                    
                    {/* Video Info Card */}
                    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm mb-6">
                      <div className="flex items-start">
                        {thumbnailUrl && (
                          <div className="w-32 h-24 rounded overflow-hidden mr-4 flex-shrink-0">
                            <img 
                              src={thumbnailUrl} 
                              alt="Video Thumbnail" 
                              className="w-full h-full object-cover"
                            />
                          </div>
                        )}
                        
                        <div className="flex-1">
                          <h3 className="text-xl font-semibold text-gray-900 mb-2">{videoTitle}</h3>
                          
                          <div className="flex flex-wrap gap-3 mt-3">
                            <div className="flex items-center px-3 py-1 bg-gray-100 rounded-full text-sm text-gray-700">
                              <FileSearch className="h-4 w-4 mr-1.5 text-gray-500" />
                              <span>{stats.totalClaims} Claims Analyzed</span>
                            </div>
                            
                            {stats.speakerCount > 0 && (
                              <div className="flex items-center px-3 py-1 bg-gray-100 rounded-full text-sm text-gray-700">
                                <Users className="h-4 w-4 mr-1.5 text-gray-500" />
                                <span>{stats.speakerCount} Speakers Identified</span>
                              </div>
                            )}
                            
                            <div className="flex items-center px-3 py-1 bg-gray-100 rounded-full text-sm text-gray-700">
                              <BarChart className="h-4 w-4 mr-1.5 text-gray-500" />
                              <span>{stats.avgConfidence}% Avg. Confidence</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Stats Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                      <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm text-center">
                        <h3 className="text-gray-600 text-sm mb-1">Analyzed Claims</h3>
                        <p className="text-3xl font-bold text-gray-900">{stats.totalClaims}</p>
                        <div className="text-xs text-gray-500 mt-2">Empirical statements verified</div>
                      </div>
                      
                      <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm text-center">
                        <h3 className="text-green-600 text-sm mb-1">Verified True</h3>
                        <p className="text-3xl font-bold text-green-600">{stats.counts.TRUE}</p>
                        <div className="text-xs text-gray-500 mt-2">Claims with factual support</div>
                      </div>
                      
                      <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm text-center">
                        <h3 className="text-red-600 text-sm mb-1">Verified False</h3>
                        <p className="text-3xl font-bold text-red-600">{stats.counts.FALSE}</p>
                        <div className="text-xs text-gray-500 mt-2">Claims contradicted by evidence</div>
                      </div>
                      
                      <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm text-center">
                        <h3 className="text-amber-600 text-sm mb-1">Unverified</h3>
                        <p className="text-3xl font-bold text-amber-600">{stats.counts.UNVERIFIED}</p>
                        <div className="text-xs text-gray-500 mt-2">Claims needing more evidence</div>
                      </div>
                    </div>
                    
                    {/* Summary and Quick Actions */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="md:col-span-2">
                        <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm h-full">
                          <h3 className="text-xl font-semibold text-gray-900 mb-4">Content Summary</h3>
                          <p className="text-gray-700 whitespace-pre-line">{summary}</p>
                        </div>
                      </div>
                      
                      <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
                        <h3 className="text-xl font-semibold text-gray-900 mb-4">Quick Actions</h3>
                        <div className="space-y-3">
                          <button 
                            onClick={() => setActiveSection('analysis')}
                            className="w-full flex items-center justify-between p-3 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors text-left"
                          >
                            <div className="flex items-center">
                              <CheckCircle className="h-5 w-5 mr-2" />
                              <span className="font-medium">View Verification Details</span>
                            </div>
                            <ArrowRight className="h-4 w-4" />
                          </button>
                          
                          <button 
                            onClick={() => setActiveSection('evidence')}
                            className="w-full flex items-center justify-between p-3 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors text-left"
                          >
                            <div className="flex items-center">
                              <Search className="h-5 w-5 mr-2" />
                              <span className="font-medium">Search for Evidence</span>
                            </div>
                            <ArrowRight className="h-4 w-4" />
                          </button>
                          
                          <button 
                            onClick={() => setActiveSection('certificate')}
                            className="w-full flex items-center justify-between p-3 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg transition-colors text-left"
                          >
                            <div className="flex items-center">
                              <Award className="h-5 w-5 mr-2" />
                              <span className="font-medium">Generate Certificate</span>
                            </div>
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
              
              {activeSection === 'analysis' && (
                <>
                  <div className="mb-8">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-bold text-gray-900">Verification Analysis</h2>
                      <button
                        onClick={() => setActiveSection('dashboard')}
                        className="flex items-center text-blue-600 hover:text-blue-800 text-sm"
                      >
                        <Settings className="h-4 w-4 mr-1.5" />
                        <span>Back to Dashboard</span>
                      </button>
                    </div>
                  </div>
                  
                  {/* Video Thumbnail */}
                  <VideoThumbnail thumbnailUrl={thumbnailUrl} videoTitle={videoTitle} />
                  
                  {/* Analysis Results */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                    <Summary summary={summary} videoTitle={videoTitle} />
                    <TranscriptDisplay transcript={transcript} />
                  </div>
                  
                  {/* Speaker Identification */}
                  {speakersData && (
                    <div className="mt-6">
                      <SpeakerIdentification 
                        speakersData={speakersData}
                        claims={empiricalClaims}
                      />
                    </div>
                  )}
                  
                  <div className="mt-8">
                    <ClaimEvaluator 
                      empiricalClaims={empiricalClaims}
                      perplexityResults={perplexityResults}
                      openAIResults={openAIResults}
                      anthropicResults={anthropicResults}
                      speakersData={speakersData}
                      videoTitle={videoTitle}
                      thumbnailUrl={thumbnailUrl}
                    />
                  </div>
                </>
              )}
              
              {activeSection === 'evidence' && (
                <>
                  <div className="mb-8">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-bold text-gray-900">Evidence Search</h2>
                      <button
                        onClick={() => setActiveSection('dashboard')}
                        className="flex items-center text-blue-600 hover:text-blue-800 text-sm"
                      >
                        <Settings className="h-4 w-4 mr-1.5" />
                        <span>Back to Dashboard</span>
                      </button>
                    </div>
                  </div>
                  
                  <div className="mt-6">
                    <KeywordGeneration
                      keywordResults={keywordResults}
                      onSearch={searchForEvidence}
                      isSearching={isSearching}
                    />
                  </div>
                  
                  <div className="mt-8" id="evidence-section">
                    <EvidenceResults
                      searchResults={searchResults}
                      isSearching={isSearching}
                    />
                  </div>
                </>
              )}
              
              {activeSection === 'certificate' && (
                <>
                  <div className="mb-8">
                    <div className="flex items-center justify-between">
                      <h2 className="text-2xl font-bold text-gray-900">Verification Certificate</h2>
                      <button
                        onClick={() => setActiveSection('dashboard')}
                        className="flex items-center text-blue-600 hover:text-blue-800 text-sm"
                      >
                        <Settings className="h-4 w-4 mr-1.5" />
                        <span>Back to Dashboard</span>
                      </button>
                    </div>
                  </div>
                  
                  <VerificationCertificate
                    videoTitle={videoTitle || 'Analyzed Video'}
                    thumbnailUrl={thumbnailUrl}
                    claims={empiricalClaims}
                    perplexityResults={perplexityResults}
                    openAIResults={openAIResults}
                    anthropicResults={anthropicResults}
                  />
                </>
              )}
            </div>
          </div>
        </section>
      )}
      
      {/* Footer Section */}
      <section className="py-10 bg-white border-t border-gray-200 mt-auto">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row items-center justify-between max-w-4xl mx-auto">
            <div className="flex items-center mb-4 md:mb-0">
              <Shield className="h-5 w-5 text-blue-600 mr-2" />
              <span className="text-gray-800 font-medium">Civic Technology</span>
              <span className="text-xs text-gray-500 ml-2">© 2025</span>
            </div>
            
            <div className="flex items-center space-x-2 text-sm text-gray-600">
              <span>Powered by multiple AI models for balanced verification</span>
              <Info className="h-4 w-4 text-gray-400" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default HomePage;