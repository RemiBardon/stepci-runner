import yaml from 'js-yaml'
import { runPhases, Phase } from 'phasic'
import fs from 'fs'
import { quantile, mean, min, max, median } from 'simple-statistics'
import { run, Workflow, WorkflowOptions, WorkflowResult, TestResult } from './index'
import { Matcher, CheckResult, checkResult } from './matcher'

export type LoadTestResult = {
  workflow: Workflow,
  result: {
    stats: {
      tests: {
        passed: number,
        total: number
      },
      steps: {
        passed: number,
        total: number
      }
    }
    responseTime: LoadTestMetric
    iterations: number,
    rps: number,
    duration: number,
    passed: boolean,
    checks?: LoadTestChecksResult
  }
}

type LoadTestMetric = {
  avg: number,
  min: number,
  max: number,
  med: number,
  p95: number,
  p99: number
}

export type LoadTestCheck = {
  avg?: number | Matcher[],
  min?: number | Matcher[],
  max?: number | Matcher[],
  med?: number | Matcher[],
  p95?: number | Matcher[],
  p99?: number | Matcher[],
}

type LoadTestChecksResult = {
  avg?: CheckResult,
  min?: CheckResult,
  max?: CheckResult,
  med?: CheckResult,
  p95?: CheckResult,
  p99?: CheckResult,
}

function metricsResult (numbers: number[]): LoadTestMetric {
  return {
    avg: mean(numbers),
    min: min(numbers),
    max: max(numbers),
    med: median(numbers),
    p95: quantile(numbers, 0.95),
    p99: quantile(numbers, 0.99),
  }
}

export async function loadTestFromFile (path: string, options?: WorkflowOptions): Promise<LoadTestResult> {
  const testFile = await fs.promises.readFile(path)
  const config = yaml.load(testFile.toString()) as Workflow
  return loadTest(config, { ...options, path })
}

// Load-testing functionality
export async function loadTest (workflow: Workflow, options?: WorkflowOptions): Promise<LoadTestResult> {
  if (!workflow.config?.loadTest?.phases) throw Error('No load test config detected')

  const start = new Date()
  const resultList = await runPhases<WorkflowResult>(workflow.config?.loadTest?.phases as Phase[], () => run(workflow, options))
  const results = resultList.map(result => (result as PromiseFulfilledResult<WorkflowResult>).value.result)

  // Tests metrics
  const totalPassed = results.filter((r) => r.passed === true)

  // Steps metrics
  const steps = results.map(r => r.tests).map(test => test.map(test => test.steps.map(step => step.passed))).flat(2)
  const stepsPassed = steps.filter(step => step)

  // Response metrics
  const responseTimes = results.map(r => r.tests).map(test => test.map(test => test.steps.map(step => step.responseTime))).flat(2)
  const responseTime = metricsResult(responseTimes)

  // Checks
  let checks: LoadTestChecksResult | undefined
  if (workflow.config?.loadTest?.check) {
    checks = {}

    if (workflow.config?.loadTest?.check.avg) {
      checks.avg = checkResult(responseTime.avg, workflow.config?.loadTest?.check.avg)
    }

    if (workflow.config?.loadTest?.check.min) {
      checks.min = checkResult(responseTime.min, workflow.config?.loadTest?.check.min)
    }

    if (workflow.config?.loadTest?.check.max) {
      checks.max = checkResult(responseTime.max, workflow.config?.loadTest?.check.max)
    }

    if (workflow.config?.loadTest?.check.med) {
      checks.med = checkResult(responseTime.med, workflow.config?.loadTest?.check.med)
    }

    if (workflow.config?.loadTest?.check.p95) {
      checks.p95 = checkResult(responseTime.p95, workflow.config?.loadTest?.check.p95)
    }

    if (workflow.config?.loadTest?.check.p99) {
      checks.p99 = checkResult(responseTime.p99, workflow.config?.loadTest?.check.p99)
    }
  }

  const result: LoadTestResult = {
    workflow,
    result: {
      stats: {
        steps: {
          passed: steps.length,
          total: stepsPassed.length
        },
        tests: {
          passed: totalPassed.length,
          total: results.length
        },
      },
      responseTime,
      rps: responseTimes.length / ((Date.now() - start.valueOf()) / 1000),
      iterations: results.length,
      duration: Date.now() - start.valueOf(),
      checks,
      passed: Object.entries(checks as object).map(([k, v]) => v.passed).every(passed => passed)
    }
  }

  options?.ee?.emit('loadtest:result', result)
  return result
}
