import { Injectable } from '@angular/core';

/**
 * Minimal FHIR StructureMap Processor
 *
 * Executes FHIR StructureMap transformations to convert CHT documents
 * to FHIR resources on-the-fly.
 *
 * Supports a subset of the FHIR Mapping Language:
 * - copy: Direct value copying
 * - evaluate: Expression evaluation
 * - Nested rule execution
 * - Conditional rules
 */
@Injectable({
  providedIn: 'root'
})
export class StructureMapProcessorService {
  private structureMaps: Map<string, any> = new Map();

  constructor() {}

  /**
   * Load a StructureMap resource
   */
  loadStructureMap(structureMap: any): void {
    if (structureMap.resourceType !== 'StructureMap') {
      throw new Error('Invalid resource type: expected StructureMap');
    }
    this.structureMaps.set(structureMap.id, structureMap);
  }

  /**
   * Transform a source document using a StructureMap
   */
  transform(structureMapId: string, source: any): any {
    const structureMap = this.structureMaps.get(structureMapId);
    if (!structureMap) {
      throw new Error(`StructureMap not found: ${structureMapId}`);
    }

    const target = {};

    // Find the main transformation group
    const mainGroup = structureMap.group?.[0];
    if (!mainGroup) {
      throw new Error('No transformation group found in StructureMap');
    }

    // Execute all rules in the group
    this.executeGroup(mainGroup, source, target);

    return target;
  }

  /**
   * Execute a transformation group
   */
  private executeGroup(group: any, source: any, target: any): void {
    if (!group.rule) {
      return;
    }

    for (const rule of group.rule) {
      this.executeRule(rule, source, target);
    }
  }

  /**
   * Execute a single transformation rule
   */
  private executeRule(rule: any, source: any, target: any): void {
    // Check if rule has a condition
    if (rule.source?.[0]?.condition) {
      if (!this.evaluateCondition(rule.source[0].condition, source)) {
        return; // Skip this rule
      }
    }

    // Extract source value
    const sourceSpec = rule.source?.[0];
    let sourceValue = source;

    if (sourceSpec?.element) {
      sourceValue = this.getNestedValue(source, sourceSpec.element);

      // If source value is undefined/null and element is required, skip
      if (sourceValue === undefined || sourceValue === null) {
        return;
      }
    }

    // Apply transformations to target
    if (rule.target) {
      for (const targetSpec of rule.target) {
        this.applyTarget(targetSpec, sourceValue, source, target);
      }
    }

    // Execute nested rules
    if (rule.rule && rule.rule.length > 0) {
      const nestedContext = this.getOrCreateNestedContext(target, rule);
      for (const nestedRule of rule.rule) {
        this.executeRule(nestedRule, source, nestedContext);
      }
    }
  }

  /**
   * Apply a target transformation
   */
  private applyTarget(targetSpec: any, sourceValue: any, source: any, target: any): void {
    const element = targetSpec.element;
    const transform = targetSpec.transform || 'copy';

    let value: any;

    switch (transform) {
      case 'copy':
        value = this.applyCopyTransform(targetSpec, sourceValue);
        break;
      case 'evaluate':
        value = this.applyEvaluateTransform(targetSpec, sourceValue, source);
        break;
      case 'create':
        value = this.applyCreateTransform(targetSpec);
        break;
      default:
        console.warn(`Unsupported transform: ${transform}`);
        value = sourceValue;
    }

    // Set the value in the target
    if (element) {
      this.setNestedValue(target, element, value, targetSpec.variable);
    }
  }

  /**
   * Copy transform: copy parameter value or source value
   */
  private applyCopyTransform(targetSpec: any, sourceValue: any): any {
    if (targetSpec.parameter && targetSpec.parameter.length > 0) {
      const param = targetSpec.parameter[0];

      // Extract value from parameter
      if (param.valueString !== undefined) return param.valueString;
      if (param.valueBoolean !== undefined) return param.valueBoolean;
      if (param.valueInteger !== undefined) return param.valueInteger;
      if (param.valueId !== undefined) {
        // Variable reference - return source value
        return sourceValue;
      }
    }

    return sourceValue;
  }

  /**
   * Evaluate transform: execute a FHIRPath-like expression
   */
  private applyEvaluateTransform(targetSpec: any, sourceValue: any, source: any): any {
    if (!targetSpec.parameter || targetSpec.parameter.length === 0) {
      return sourceValue;
    }

    const expression = targetSpec.parameter[0].valueString;

    // Simple expression evaluator (supports a minimal subset)
    try {
      // Handle concatenation expressions like 'Location/' + parentId
      if (expression.includes('+')) {
        return this.evaluateConcatenation(expression, source);
      }

      // Handle substring/replace operations
      if (expression.includes('.substring') || expression.includes('.replace')) {
        return this.evaluateStringOperation(expression, sourceValue);
      }

      return sourceValue;
    } catch (error) {
      console.error('Failed to evaluate expression:', expression, error);
      return sourceValue;
    }
  }

  /**
   * Create transform: create a new empty object
   */
  private applyCreateTransform(targetSpec: any): any {
    return {};
  }

  /**
   * Evaluate concatenation expressions
   */
  private evaluateConcatenation(expression: string, source: any): string {
    // Extract parts: 'Location/' + parentId
    const parts = expression.split('+').map(p => p.trim());
    let result = '';

    for (const part of parts) {
      if (part.startsWith("'") && part.endsWith("'")) {
        // String literal
        result += part.slice(1, -1);
      } else {
        // Variable reference
        const value = this.getNestedValue(source, part);
        result += value || '';
      }
    }

    return result;
  }

  /**
   * Evaluate string operations like substring and replace
   */
  private evaluateStringOperation(expression: string, value: any): string {
    let result = String(value || '');

    // Simple regex to extract operations
    // Example: dob.substring(0,10).replace('-0-','-01-')

    // Handle substring
    const substringMatch = expression.match(/\.substring\((\d+),\s*(\d+)\)/);
    if (substringMatch) {
      const start = parseInt(substringMatch[1]);
      const end = parseInt(substringMatch[2]);
      result = result.substring(start, end);
    }

    // Handle replace
    const replaceMatch = expression.match(/\.replace\('([^']+)',\s*'([^']*)'\)/);
    if (replaceMatch) {
      const searchValue = replaceMatch[1];
      const replaceValue = replaceMatch[2];
      result = result.replace(searchValue, replaceValue);
    }

    return result;
  }

  /**
   * Evaluate a condition expression
   */
  private evaluateCondition(condition: string, source: any): boolean {
    // Simple condition evaluator
    // Supports: "type = 'clinic'", "(type = 'health_center') or (type = 'district_hospital')"

    try {
      // Handle OR conditions
      if (condition.includes(' or ')) {
        const parts = condition.split(' or ').map(p => p.trim());
        return parts.some(part => this.evaluateSingleCondition(part, source));
      }

      return this.evaluateSingleCondition(condition, source);
    } catch (error) {
      console.error('Failed to evaluate condition:', condition, error);
      return false;
    }
  }

  /**
   * Evaluate a single condition (e.g., "type = 'clinic'")
   */
  private evaluateSingleCondition(condition: string, source: any): boolean {
    // Remove parentheses
    condition = condition.replace(/[()]/g, '').trim();

    // Parse: field = 'value'
    const match = condition.match(/(\w+)\s*=\s*'([^']+)'/);
    if (match) {
      const field = match[1];
      const expectedValue = match[2];
      const actualValue = this.getNestedValue(source, field);
      return actualValue === expectedValue;
    }

    return false;
  }

  /**
   * Get or create nested context for rule execution
   */
  private getOrCreateNestedContext(target: any, rule: any): any {
    const targetSpec = rule.target?.[0];
    if (!targetSpec) {
      return target;
    }

    const element = targetSpec.element;
    const variable = targetSpec.variable;

    if (variable) {
      // Create a new object for the variable
      const newContext = {};

      // Add it to the target array or object
      if (element) {
        if (!target[element]) {
          target[element] = [];
        }
        if (Array.isArray(target[element])) {
          target[element].push(newContext);
        } else {
          target[element] = [target[element], newContext];
        }
      }

      return newContext;
    }

    return target;
  }

  /**
   * Get nested value from object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    if (!path) return obj;

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Set nested value in object using dot notation
   */
  private setNestedValue(obj: any, path: string, value: any, isVariable?: string): void {
    if (!path) return;

    const parts = path.split('.');
    let current = obj;

    // Navigate to parent
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }

    // Set the value
    const lastPart = parts[parts.length - 1];

    // Handle array fields (like identifier, name, telecom, etc.)
    const arrayFields = ['identifier', 'name', 'telecom', 'extension', 'type', 'tag', 'coding'];
    if (arrayFields.includes(lastPart) && isVariable) {
      // Initialize as array if needed
      if (!current[lastPart]) {
        current[lastPart] = [];
      }
      // Value will be set in nested rules
    } else {
      current[lastPart] = value;
    }
  }

  /**
   * Transform a CHT person to FHIR Patient
   */
  transformPersonToPatient(chtPerson: any): any {
    return this.transform('cht-person-to-fhir-patient', chtPerson);
  }

  /**
   * Transform a CHT place to FHIR Location
   */
  transformPlaceToLocation(chtPlace: any): any {
    return this.transform('cht-place-to-fhir-location', chtPlace);
  }

  /**
   * Auto-detect and transform CHT document to appropriate FHIR resource
   */
  transformChtDocument(chtDoc: any): any {
    if (!chtDoc.type) {
      throw new Error('CHT document missing type field');
    }

    switch (chtDoc.type) {
      case 'person':
        return this.transformPersonToPatient(chtDoc);
      case 'clinic':
      case 'health_center':
      case 'district_hospital':
        return this.transformPlaceToLocation(chtDoc);
      default:
        throw new Error(`Unsupported CHT document type: ${chtDoc.type}`);
    }
  }
}
