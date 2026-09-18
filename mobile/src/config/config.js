// const API_BASE_URL = "https://apartmentbilltracker-servers.onrender.com";
const API_BASE_URL = "https://propertyflowserver.onrender.com";
// const API_BASE_URL = "http://10.18.100.4:4000";

export const setAPIBaseURL = (url) => {
  global.API_BASE_URL = url;
};

export const getAPIBaseURL = () => {
  return global.API_BASE_URL || API_BASE_URL;
};
