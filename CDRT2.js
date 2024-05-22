const axios = require('axios');

// Recursive function to search for a specific URI within an object
function findUriRecursively(obj, targetUri) {
  if (typeof obj === 'object' && obj !== null) {
    if (Array.isArray(obj)) {
      for (let item of obj) {
        let foundUri = findUriRecursively(item, targetUri);
        if (foundUri) return foundUri;
      }
    } else {
      for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
          if (typeof obj[key] === 'string' && obj[key] === targetUri) {
            return obj[key];
          }
          let foundUri = findUriRecursively(obj[key], targetUri);
          if (foundUri) return foundUri;
        }
      }
    }
  }
  return null;
}

// Function to retrieve the label from the given URI
async function getLabelFromUri(uri) {
  try {
    const response = await axios.get(uri);
    const data = response.data;

    const identifiedBy = data["identified_by"];
    if (Array.isArray(identifiedBy)) {
      for (let item of identifiedBy) {
        if (item.classified_as) {
          let foundUri = findUriRecursively(item.classified_as, "http://vocab.getty.edu/aat/300404670");
          if (foundUri) {
            return item.content;
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error fetching data from ${uri}`);
  }
  return null;
}

// Function to fetch data from a URL
async function fetchData(uri) {
  try {
    const response = await import('node-fetch');
    const fetch = response.default;

    const res = await fetch(uri);
    if (res.ok) {
      return await res.json();
    }
  } catch (error) {
    console.error(`An error occurred while fetching data from ${uri}:`, error);
  }
  return null;
}

async function getCreatorName(data) {
  // Function to recursively search for 'carried_out_by' within 'produced_by'
  async function findCarriedOutBy(obj) {
    let creatorIds = [];

    async function recursiveSearch(obj) {
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj)) {
          for (let item of obj) {
            await recursiveSearch(item);
          }
        } else {
          if (obj.hasOwnProperty('carried_out_by')) {
            creatorIds.push(obj.carried_out_by[0].id);
          }
          for (let key in obj) {
            if (obj.hasOwnProperty(key)) {
              await recursiveSearch(obj[key]);
            }
          }
        }
      }
    }

    await recursiveSearch(obj);

    // Check if all URIs are the same
    const uniqueUris = [...new Set(creatorIds)];
    if (uniqueUris.length > 1) {
      return "Ambiguous creator data found.";
    } else if (uniqueUris.length === 1) {
      const creatorName = await getLabelFromUri(uniqueUris[0]);
      return creatorName ? creatorName : `Name not found. URI: ${uniqueUris[0]}`;
    } else {
      return null;
    }
  }

  if (data && data.produced_by) {
    return await findCarriedOutBy(data.produced_by);
  }

  return null;
}

// Example usage with URLs
(async function() {
  const articUrl = 'https://example.com/artic.json';
  const gettyUrl = 'https://data.getty.edu/museum/collection/object/0a0fdd7a-8859-4cae-8a5e-8f16ef25a8f6';
  const luxUrl = 'https://example.com/lux.json';
  const okeeffeUrl = 'https://example.com/okeeffe.json';
  const viennaUrl = 'https://example.com/vienna.json';
  const ambiguousUrl = 'https://example.com/ambiguous.json';

  const articData = await fetchData(articUrl);
  const gettyData = await fetchData(gettyUrl);
  const luxData = await fetchData(luxUrl);
  const okeeffeData = await fetchData(okeeffeUrl);
  const viennaData = await fetchData(viennaUrl);
  const ambiguousData = await fetchData(ambiguousUrl);

  if (articData) console.log('ARTIC:', await getCreatorName(articData));
  if (gettyData) console.log('GETTY:', await getCreatorName(gettyData));
  if (luxData) console.log('LUX:', await getCreatorName(luxData));
  if (okeeffeData) console.log('O KEEFFE:', await getCreatorName(okeeffeData));
  if (viennaData) console.log('VIENNA:', await getCreatorName(viennaData));
  if (ambiguousData) console.log('AMBIGUOUS:', await getCreatorName(ambiguousData));
})();
