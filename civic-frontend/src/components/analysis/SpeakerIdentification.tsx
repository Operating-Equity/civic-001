import React, { useState } from 'react';
import { Users, User, ChevronDown, ChevronUp, Clock, BarChart2, FileText } from 'lucide-react';
import { SpeakersData, ClaimAnalysis } from '../../types';

interface SpeakerIdentificationProps {
  speakersData: SpeakersData;
  claims?: ClaimAnalysis[];
}

// Generate color for a speaker - consistent across renders
const getSpeakerColor = (speakerId: string) => {
  const colors = [
    'bg-blue-500 text-white',
    'bg-green-500 text-white',
    'bg-purple-500 text-white',
    'bg-amber-500 text-white',
    'bg-pink-500 text-white',
    'bg-teal-500 text-white',
    'bg-indigo-500 text-white',
    'bg-red-500 text-white'
  ];
  
  // Simple hash function to get a consistent color
  const hash = speakerId.split('').reduce((acc, char) => {
    return char.charCodeAt(0) + acc;
  }, 0);
  
  return colors[hash % colors.length];
};

const SpeakerIdentification: React.FC<SpeakerIdentificationProps> = ({ speakersData, claims = [] }) => {
  const [expanded, setExpanded] = useState(false);
  
  // If no speaker data, don't render
  if (!speakersData || !speakersData.speakers || Object.keys(speakersData.speakers).length === 0) {
    return null;
  }
  
  // Count claims per speaker
  const speakerClaimCounts: Record<string, number> = {};
  claims.forEach(claim => {
    if (claim.speaker && claim.speaker.id) {
      speakerClaimCounts[claim.speaker.id] = (speakerClaimCounts[claim.speaker.id] || 0) + 1;
    }
  });
  
  // Calculate speaking time per speaker in seconds
  const speakerTimes: Record<string, number> = {};
  speakersData.segments.forEach(segment => {
    if (segment.speaker) {
      const duration = segment.end - segment.start;
      speakerTimes[segment.speaker] = (speakerTimes[segment.speaker] || 0) + duration;
    }
  });
  
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 bg-blue-100 rounded-md">
            <Users className="h-5 w-5 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900">Speaker Identification</h2>
        </div>
        
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-gray-500 hover:text-gray-700 p-1 rounded-full hover:bg-gray-100"
        >
          {expanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
        </button>
      </div>
      
      <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mb-4">
        <p className="text-gray-700 text-sm">
          Speakers identified: <strong>{Object.keys(speakersData.speakers).length}</strong>
        </p>
      </div>
      
      {/* Speaker Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {Object.entries(speakersData.speakers).map(([speakerId, speakerName]) => {
          const speakerColor = getSpeakerColor(speakerId);
          const claimCount = speakerClaimCounts[speakerId] || 0;
          const speakingTime = speakerTimes[speakerId] || 0;
          
          return (
            <div key={speakerId} className="flex items-start p-3 bg-white border border-gray-200 rounded-lg">
              <div className={`flex-shrink-0 w-10 h-10 ${speakerColor} rounded-full flex items-center justify-center mr-3`}>
                <User className="h-5 w-5" />
              </div>
              
              <div className="flex-1">
                <h3 className="font-medium text-gray-900">{speakerName}</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  <div className="flex items-center text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
                    <Clock className="h-3 w-3 mr-1" />
                    <span>{Math.round(speakingTime)} seconds</span>
                  </div>
                  
                  <div className="flex items-center text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded-full">
                    <FileText className="h-3 w-3 mr-1" />
                    <span>{claimCount} claims</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Expanded Content - Speaking Time chart and segment visualization */}
      {expanded && (
        <div className="space-y-6">
          <div>
            <h3 className="font-medium text-gray-800 mb-3 flex items-center">
              <BarChart2 className="h-4 w-4 mr-1.5 text-blue-500" />
              Speaking Time Distribution
            </h3>
            
            <div className="space-y-3">
              {Object.entries(speakerTimes).map(([speakerId, time]) => {
                const speakerName = speakersData.speakers[speakerId] || `Speaker ${speakerId}`;
                const speakerColor = getSpeakerColor(speakerId);
                const totalTime = Object.values(speakerTimes).reduce((sum, t) => sum + t, 0);
                const percentage = Math.round((time / totalTime) * 100);
                
                return (
                  <div key={speakerId} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-gray-700">{speakerName}</span>
                      <span className="text-gray-500">{Math.round(time)}s ({percentage}%)</span>
                    </div>
                    <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${speakerColor.split(' ')[0]}`}
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          
          <div>
            <h3 className="font-medium text-gray-800 mb-3">Transcript Segments by Speaker</h3>
            
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="max-h-60 overflow-y-auto">
                {speakersData.segments.map((segment, index) => {
                  const speakerName = speakersData.speakers[segment.speaker] || `Speaker ${segment.speaker}`;
                  const speakerColor = getSpeakerColor(segment.speaker);
                  
                  return (
                    <div 
                      key={index} 
                      className={`p-3 ${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'} border-b border-gray-200 last:border-b-0`}
                    >
                      <div className="flex items-start">
                        <div className={`flex-shrink-0 h-6 w-6 ${speakerColor} rounded-full flex items-center justify-center mr-2 mt-0.5`}>
                          <User className="h-3 w-3" />
                        </div>
                        <div>
                          <div className="flex items-center">
                            <span className="font-medium text-sm text-gray-800">{speakerName}</span>
                            <span className="ml-2 text-xs text-gray-500">
                              {Math.floor(segment.start / 60)}:{Math.round(segment.start % 60).toString().padStart(2, '0')} - 
                              {Math.floor(segment.end / 60)}:{Math.round(segment.end % 60).toString().padStart(2, '0')}
                            </span>
                          </div>
                          <p className="text-sm text-gray-700 mt-1">{segment.text}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          
          {/* Speaker Claims Table */}
          {claims.length > 0 && (
            <div>
              <h3 className="font-medium text-gray-800 mb-3">Claims by Speaker</h3>
              
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Speaker</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Claim</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {claims.filter(claim => claim.speaker).map((claim, index) => {
                      if (!claim.speaker) return null;
                      
                      const speakerName = speakersData.speakers[claim.speaker.id] || `Speaker ${claim.speaker.id}`;
                      const speakerColor = getSpeakerColor(claim.speaker.id);
                      
                      return (
                        <tr key={index}>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center">
                              <div className={`flex-shrink-0 h-6 w-6 ${speakerColor} rounded-full flex items-center justify-center mr-2`}>
                                <User className="h-3 w-3" />
                              </div>
                              <span className="text-sm text-gray-800">{speakerName}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700">{claim.claim}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SpeakerIdentification;