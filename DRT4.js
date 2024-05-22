const fs = require('fs');
const axios = require('axios');

// Function to recursively search for a vocab.getty.edu URI within an object
function findGettyUri(obj) {
  if (typeof obj === 'object' && obj !== null) {
    if (Array.isArray(obj)) {
      for (let item of obj) {
        let foundUri = findGettyUri(item);
        if (foundUri) return foundUri;
      }
    } else {
      for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
          if (typeof obj[key] === 'string' && obj[key].includes('vocab.getty.edu')) {
            return obj[key];
          }
          let foundUri = findGettyUri(obj[key]);
          if (foundUri) return foundUri;
        }
      }
    }
  }
  return null;
}

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

// Function to retrieve the preferred term from the AAT JSON
async function getPreferredTerm(uri) {
  try {
    const response = await axios.get(`${uri}.json`);
    const data = response.data;
    const identifiedBy = data["identified_by"];
    if (Array.isArray(identifiedBy)) {
      for (let item of identifiedBy) {
        if (item.classified_as && item.classified_as.some(ca => ca.id === "http://vocab.getty.edu/aat/300404670")) {
          return item.content;
        }
      }
    }
  } catch (error) {
    console.error(`Error fetching data from ${uri}:`, error);
  }
  return null;
}

// Function to check if the dimension should be excluded
function shouldExcludeDimension(dimension) {
  if (dimension.classified_as) {
    for (let classification of dimension.classified_as) {
      let uri = findGettyUri(classification);
      if (uri && uri === "http://vocab.getty.edu/aat/300010269") {
        return true;
      }
    }
  }
  return false;
}

// Function to retrieve the label of a member_of set
async function getMemberOfLabel(uri) {
  try {
    const response = await axios.get(uri);
    const data = response.data;
    return data._label || null;
  } catch (error) {
    console.error(`Error fetching data from ${uri}:`, error);
  }
  return null;
}

// Function to retrieve the label of an additional classification
async function getAdditionalClassificationLabel(uri) {
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
    console.error(`Error fetching data from ${uri}:`, error);
  }
  return null;
}

// Function to construct the dimensions statement for pattern one
async function constructDimensionsStatementPatternOne(dimension) {
  if (shouldExcludeDimension(dimension)) {
    return null;
  }

  let dimensionLabel = null;
  let unitLabel = null;

  // Search for a vocab.getty.edu URI within the classified_as property
  const dimensionUri = findGettyUri(dimension.classified_as);
  if (dimensionUri) {
    dimensionLabel = await getPreferredTerm(dimensionUri);
  }

  // Search for a vocab.getty.edu URI within the unit property
  const unitUri = findGettyUri(dimension.unit);
  if (unitUri) {
    unitLabel = await getPreferredTerm(unitUri);
  }

  if (dimension.value && dimensionLabel && unitLabel) {
    const statement = `${dimensionLabel}: ${dimension.value} ${unitLabel}`;
    return statement;
  }
  return null;
}

// Function to construct the dimensions statement for pattern two
async function constructDimensionsStatementPatternTwo(dimension) {
  if (shouldExcludeDimension(dimension)) {
    return null;
  }

  let dimensionLabel = null;
  let unitLabel = null;
  let additionalClassLabel = null;

  // Ensure that we handle two classified_as properties
  if (dimension.classified_as && dimension.classified_as.length > 0) {
    // First classified_as is the dimension type (e.g., height, width)
    const dimensionUri = findGettyUri(dimension.classified_as[0]);
    if (dimensionUri) {
      dimensionLabel = await getPreferredTerm(dimensionUri);
    }

    // If there's a second classified_as, it's the qualifier (e.g., frame)
    if (dimension.classified_as.length > 1) {
      const additionalUri = dimension.classified_as[1].id;
      if (additionalUri) {
        additionalClassLabel = await getAdditionalClassificationLabel(additionalUri);
      }
    }
  }

  // Search for a vocab.getty.edu URI within the unit property
  const unitUri = findGettyUri(dimension.unit);
  if (unitUri) {
    unitLabel = await getPreferredTerm(unitUri);
  }

  if (dimension.value && dimensionLabel && unitLabel) {
    let statement = `${dimensionLabel}: ${dimension.value} ${unitLabel}`;
    if (additionalClassLabel) {
      return { statement, additionalClassLabel };
    }
    return { statement, additionalClassLabel: 'Default Set' };
  }
  return null;
}

// Function to retrieve dimensions from the dataset
async function getDimensions(data) {
  let dimensionsArray = [];
  let dimensionsBySet = {};

  async function processDimension(dimension) {
    let dimensionsData;

    // Check if the dimension belongs to a set via member_of
    if (dimension.member_of && Array.isArray(dimension.member_of)) {
      dimensionsData = await constructDimensionsStatementPatternOne(dimension);
      if (dimensionsData) {
        let setLabel = 'Default Set';
        for (let member of dimension.member_of) {
          let label = await getMemberOfLabel(member.id);
          if (label) {
            setLabel = label;
            break;
          }
        }
        if (!dimensionsBySet[setLabel]) {
          dimensionsBySet[setLabel] = [];
        }
        dimensionsBySet[setLabel].push(dimensionsData);
      }
    } else { // Use pattern two
      dimensionsData = await constructDimensionsStatementPatternTwo(dimension);
      if (dimensionsData) {
        let { statement, additionalClassLabel } = dimensionsData;
        if (!dimensionsBySet[additionalClassLabel]) {
          dimensionsBySet[additionalClassLabel] = [];
        }
        dimensionsBySet[additionalClassLabel].push(statement);
      }
    }
  }

  if (data.dimension && Array.isArray(data.dimension)) {
    for (let dim of data.dimension) {
      await processDimension(dim);
    }
  }

  for (let set in dimensionsBySet) {
    dimensionsArray.push(`${set}: ${dimensionsBySet[set].join('; ')}`);
  }

  return dimensionsArray.length > 0 ? dimensionsArray.join('\n') : null;
}

// Example usage with the provided JSON files
(async function() {
  const articData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\ARTIC example.json', 'utf8'));
  const gettyData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\GETTY example.json', 'utf8'));
  const luxData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\LUX example 2.json', 'utf8'));
  const okeeffeData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\O KEEFFE example.json', 'utf8'));
  const viennaData = JSON.parse(fs.readFileSync('C:\\Users\\tanai\\OneDrive\\Desktop\\Knossos Mapped Data\\VIENNA example.json', 'utf8'));

  const datasets = [
    { name: 'ARTIC', data: articData },
    { name: 'GETTY', data: gettyData },
    { name: 'LUX', data: luxData },
    { name: 'O KEEFFE', data: okeeffeData },
    { name: 'VIENNA', data: viennaData },
  ];

  for (let dataset of datasets) {
    const dimensions = await getDimensions(dataset.data);
    console.log(`${dataset.name}: ${dimensions}`);
  }
})();
