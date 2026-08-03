const {
  invokeResolvedPageAction,
  resolvePageAction
} = require('../runner/page-action-registry');
const { waitForPageParse } = require('../runner/page-vm-driver');

function inputEvent(value) {
  return { detail: { value } };
}

async function enterAndParse(driver, input) {
  if (driver.surface === 'HOME_QUICK') {
    driver.page.onComposerInput(inputEvent(input));
    driver.page.submitComposer();
  } else if (driver.surface === 'FULL_PAGE') {
    driver.page.onTextInput(inputEvent(input));
    driver.page.runParse();
  } else {
    throw Object.assign(new Error(`Unsupported order entry surface: ${driver.surface}`), {
      code: 'AUTOMATION_DRIVER_ERROR'
    });
  }
  await waitForPageParse(driver.page);
  return driver.page.data.parseResult || null;
}

function invokeFormalSave(driver) {
  const resolution = resolvePageAction({
    availablePageMethods: driver.page,
    editMode: 'CREATE',
    entrySurface: driver.surface,
    requestedAction: 'SAVE_FORMAL'
  });
  return invokeResolvedPageAction(driver.page, resolution, {
    readMethodCount: () => driver.evidence.pageMethodCalls[resolution.resolvedMethodName] || 0
  });
}

module.exports = { enterAndParse, inputEvent, invokeFormalSave };
